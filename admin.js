/* Sons of Cauvery - gallery admin.
 *
 * How it works: the site is a GitHub Pages site, so the "database" is the repository itself.
 * - data/gallery.json holds the order, titles and banner list; the public pages read it.
 * - New photos are resized + compressed in the browser and saved to media/ in the repo.
 * - Every "Publish" is one git commit made through the GitHub API; Pages redeploys in ~1 minute.
 * - The GitHub key (fine-grained token, this repo only, Contents read/write) is stored in
 *   data/admin-config.json encrypted with the passcode (PBKDF2 + AES-GCM), so only people who
 *   know the passcode can use it.
 */
(function () {
    'use strict';

    var CONFIG_PATH = 'data/admin-config.json';
    var GALLERY_PATH = 'data/gallery.json';
    var WIDTHS = [480, 960, 1920];
    var QUALITY = 0.8;
    var MAX_VIDEO_MB = 45;
    var KDF_ITERATIONS = 600000;
    var SESSION_KEY = 'soc-admin-token';

    var $ = function (sel) { return document.querySelector(sel); };
    var enc = new TextEncoder();
    var dec = new TextDecoder();

    var config = null;       // contents of admin-config.json
    var token = null;        // decrypted GitHub token (memory only unless "keep me unlocked")
    var state = null;        // { items: [...], banner: [...] } being edited
    var baseCommit = null;   // commit sha the edit started from
    var pendingBlobs = {};   // path -> blob sha, uploaded but not yet committed
    var pendingDeletes = {}; // path -> true
    var uploading = 0;
    var dirty = false;

    // ---------------------------------------------------------------- helpers

    function icon(name) {
        return '<svg class="icon" aria-hidden="true"><use href="icons.svg#' + name + '"></use></svg>';
    }

    function show(id) {
        ['#view-loading', '#view-unlock', '#view-setup', '#view-editor'].forEach(function (v) {
            $(v).classList.toggle('hidden', v !== id);
        });
        var editing = id === '#view-editor';
        $('#publish-bar').classList.toggle('hidden', !editing);
        $('#btn-settings').classList.toggle('hidden', !editing);
        $('#btn-lock').classList.toggle('hidden', !editing);
    }

    function message(el, text, kind) {
        el.textContent = text;
        el.className = 'msg show ' + (kind || 'info');
        if (!text) el.className = 'msg';
    }

    function b64FromBytes(bytes) {
        var bin = '';
        var chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(bin);
    }

    function bytesFromB64(b64) {
        var bin = atob(b64.replace(/\s/g, ''));
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function blobToB64(blob) {
        return blob.arrayBuffer().then(function (buf) { return b64FromBytes(new Uint8Array(buf)); });
    }

    function newId(prefix) {
        var d = new Date();
        var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        var rand = Math.random().toString(36).slice(2, 7);
        return prefix + '-' + stamp + '-' + rand;
    }

    function ext(item) { return item.ext || 'webp'; }

    function filesOf(item) {
        if (item.type === 'youtube') return [];
        var base = item.type === 'video' ? item.id + '-poster' : item.id;
        var files = (item.widths || []).map(function (w) { return 'media/' + base + '-' + w + '.' + ext(item); });
        if (item.type === 'video') files.push('media/' + item.id + '.' + (item.videoExt || 'mp4'));
        return files;
    }

    function thumbUrl(item) {
        if (item._preview) return item._preview;
        if (item.type === 'youtube') return 'https://i.ytimg.com/vi/' + item.youtubeId + '/hqdefault.jpg';
        if (!item.widths) return 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';  // still processing
        var base = item.type === 'video' ? item.id + '-poster' : item.id;
        return 'media/' + base + '-' + (item.widths || [480])[0] + '.' + ext(item);
    }

    function setDirty() {
        dirty = true;
        updatePublishBar();
    }

    // ---------------------------------------------------------------- crypto

    function deriveKey(pass, salt, iterations) {
        return crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']).then(function (base) {
            return crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
                base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        });
    }

    function encryptToken(tok, pass) {
        var salt = crypto.getRandomValues(new Uint8Array(16));
        var iv = crypto.getRandomValues(new Uint8Array(12));
        return deriveKey(pass, salt, KDF_ITERATIONS).then(function (key) {
            return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(tok));
        }).then(function (ct) {
            return {
                kdf: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS,
                salt: b64FromBytes(salt), iv: b64FromBytes(iv), token: b64FromBytes(new Uint8Array(ct))
            };
        });
    }

    function decryptToken(cfg, pass) {
        return deriveKey(pass, bytesFromB64(cfg.salt), cfg.iterations).then(function (key) {
            return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytesFromB64(cfg.iv) }, key, bytesFromB64(cfg.token));
        }).then(function (pt) { return dec.decode(pt); });
    }

    // ---------------------------------------------------------------- GitHub API

    function gh(path, opts, tok) {
        opts = opts || {};
        var headers = {
            'Accept': 'application/vnd.github+json',
            'Authorization': 'Bearer ' + (tok || token),
            'X-GitHub-Api-Version': '2022-11-28'
        };
        if (opts.body) headers['Content-Type'] = 'application/json';
        return fetch('https://api.github.com' + path, {
            method: opts.method || 'GET',
            headers: headers,
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            cache: 'no-store'
        }).then(function (r) {
            if (r.status === 204) return null;
            return r.json().catch(function () { return {}; }).then(function (json) {
                if (!r.ok) {
                    var err = new Error(json.message || ('GitHub error ' + r.status));
                    err.status = r.status;
                    throw err;
                }
                return json;
            });
        });
    }

    function repoPath(cfg) {
        cfg = cfg || config;
        return '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo);
    }

    function friendlyError(err) {
        if (err.status === 401) return 'GitHub rejected the key. It may have expired. Open Settings and paste a new key.';
        if (err.status === 403) return 'The GitHub key does not have permission. Make sure Contents is set to "Read and write" for this repository.';
        if (err.status === 404) return 'Repository or branch not found. Check the username, repository name and branch.';
        if (err.status === 409 || err.status === 422) return 'Someone else published changes at the same moment. Reload the page and try again.';
        if (err instanceof TypeError) return 'Network problem. Check your internet connection and try again.';
        return err.message || String(err);
    }

    function getHead() {
        return gh(repoPath() + '/git/ref/heads/' + encodeURIComponent(config.branch)).then(function (ref) {
            return ref.object.sha;
        });
    }

    function readRepoFile(path, ref) {
        return gh(repoPath() + '/contents/' + path + '?ref=' + encodeURIComponent(ref)).then(function (f) {
            return { sha: f.sha, text: dec.decode(bytesFromB64(f.content)) };
        });
    }

    function createBlob(base64) {
        return gh(repoPath() + '/git/blobs', { method: 'POST', body: { content: base64, encoding: 'base64' } })
            .then(function (b) { return b.sha; });
    }

    // ---------------------------------------------------------------- start-up

    function guessRepo() {
        var host = location.hostname;
        var m = host.match(/^([^.]+)\.github\.io$/i);
        if (!m) return null;
        var seg = location.pathname.split('/').filter(Boolean)[0];
        var repo = seg && !/\.html?$/i.test(seg) ? seg : host;
        return { owner: m[1], repo: repo };
    }

    function init() {
        fetch(CONFIG_PATH, { cache: 'no-cache' }).then(function (r) {
            if (r.status === 404) return null;
            if (!r.ok) throw new Error('Could not load admin settings (' + r.status + ')');
            return r.json();
        }).then(function (cfg) {
            if (!cfg || !cfg.token) return startSetup(false);
            config = cfg;
            var saved = null;
            try { saved = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY); } catch (e) { /* storage blocked */ }
            if (saved) {
                token = saved;
                return openEditor().catch(function () {
                    forget();
                    show('#view-unlock');
                });
            }
            show('#view-unlock');
            $('#unlock-pass').focus();
        }).catch(function (err) {
            show('#view-unlock');
            message($('#unlock-msg'), friendlyError(err), 'error');
        });
    }

    function forget() {
        token = null;
        try { sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    }

    // ---------------------------------------------------------------- unlock

    $('#form-unlock').addEventListener('submit', function (e) {
        e.preventDefault();
        var pass = $('#unlock-pass').value;
        var msg = $('#unlock-msg');
        message(msg, 'Checking passcode...', 'info');
        decryptToken(config, pass).then(function (tok) {
            token = tok;
            try {
                if ($('#unlock-remember').checked) localStorage.setItem(SESSION_KEY, tok);
                else sessionStorage.setItem(SESSION_KEY, tok);
            } catch (err) { /* storage blocked: stay unlocked for this page only */ }
            $('#unlock-pass').value = '';
            message(msg, '', '');
            return openEditor();
        }, function () {
            message(msg, 'Wrong passcode. Please try again.', 'error');
        }).catch(function (err) {
            message(msg, friendlyError(err), 'error');
        });
    });

    $('#btn-lock').addEventListener('click', function () {
        if (dirty && !confirm('You have unpublished changes. Lock anyway and lose them?')) return;
        dirty = false;
        forget();
        location.reload();
    });

    // ---------------------------------------------------------------- setup

    var settingsMode = false;

    function startSetup(isSettings) {
        settingsMode = isSettings;
        var guess = guessRepo();
        $('#setup-title').textContent = isSettings ? 'Settings' : 'One-time setup';
        $('#setup-hint').textContent = isSettings
            ? 'Change the passcode, or paste a new GitHub key if the old one expired. Leave the key empty to keep the current one.'
            : 'Do this once. After that, you and your friend only need the passcode.';
        $('#setup-owner').value = (config && config.owner) || (guess && guess.owner) || '';
        $('#setup-repo').value = (config && config.repo) || (guess && guess.repo) || '';
        $('#setup-branch').value = (config && config.branch) || 'main';
        $('#setup-token').required = !isSettings;
        $('#token-help').open = !isSettings;
        $('#setup-cancel').classList.toggle('hidden', !isSettings);
        message($('#setup-msg'), '', '');
        show('#view-setup');
    }

    $('#btn-settings').addEventListener('click', function () {
        if (dirty && !confirm('You have unpublished changes. They will be kept, but publish them before closing the page. Continue to settings?')) return;
        startSetup(true);
    });

    $('#setup-cancel').addEventListener('click', function () { show('#view-editor'); });

    $('#form-setup').addEventListener('submit', function (e) {
        e.preventDefault();
        var msg = $('#setup-msg');
        var cfg = {
            owner: $('#setup-owner').value.trim(),
            repo: $('#setup-repo').value.trim(),
            branch: $('#setup-branch').value.trim() || 'main'
        };
        var newToken = $('#setup-token').value.trim() || (settingsMode ? token : '');
        var pass = $('#setup-pass').value;
        if (pass.length < 8) return message(msg, 'The passcode needs at least 8 characters.', 'error');
        if (pass !== $('#setup-pass2').value) return message(msg, 'The two passcodes do not match.', 'error');
        if (!newToken) return message(msg, 'Paste the GitHub key first.', 'error');

        $('#setup-submit').disabled = true;
        message(msg, 'Checking the GitHub key...', 'info');
        gh(repoPath(cfg), null, newToken).then(function (repo) {
            if (repo.permissions && !repo.permissions.push) {
                var err = new Error('no push'); err.status = 403; throw err;
            }
            message(msg, 'Encrypting and saving...', 'info');
            return encryptToken(newToken, pass);
        }).then(function (secret) {
            var full = Object.assign({ version: 1, note: 'Gallery admin settings. The GitHub key is encrypted with the admin passcode.' }, cfg, secret);
            var body = {
                message: settingsMode ? 'Update gallery admin settings' : 'Set up gallery admin',
                content: b64FromBytes(enc.encode(JSON.stringify(full, null, 2) + '\n')),
                branch: cfg.branch
            };
            // Include the current file sha when it exists so GitHub allows the overwrite.
            return gh(repoPath(cfg) + '/contents/' + CONFIG_PATH + '?ref=' + encodeURIComponent(cfg.branch), null, newToken)
                .then(function (f) { body.sha = f.sha; }, function () { /* new file */ })
                .then(function () {
                    return gh(repoPath(cfg) + '/contents/' + CONFIG_PATH, { method: 'PUT', body: body }, newToken);
                })
                .then(function () { return full; });
        }).then(function (full) {
            config = full;
            token = newToken;
            try { sessionStorage.setItem(SESSION_KEY, token); } catch (err) { /* ignore */ }
            $('#setup-pass').value = $('#setup-pass2').value = $('#setup-token').value = '';
            $('#setup-submit').disabled = false;
            if (settingsMode && state) {
                show('#view-editor');
                toast('Settings saved. Share the new passcode with your friend.', 'ok');
            } else {
                return openEditor().then(function () {
                    toast('Setup complete. Share the passcode with your friend; the admin page works for them in about a minute.', 'ok');
                });
            }
        }).catch(function (err) {
            $('#setup-submit').disabled = false;
            message(msg, friendlyError(err), 'error');
        });
    });

    // ---------------------------------------------------------------- editor

    function openEditor() {
        show('#view-loading');
        return getHead().then(function (sha) {
            baseCommit = sha;
            return readRepoFile(GALLERY_PATH, sha).catch(function (err) {
                if (err.status === 404) return { text: '{"items":[],"banner":[]}' };
                throw err;
            });
        }).then(function (file) {
            var data = JSON.parse(file.text);
            state = { items: data.items || [], banner: data.banner || [] };
            pendingBlobs = {};
            pendingDeletes = {};
            dirty = false;
            render();
            show('#view-editor');
        }).catch(function (err) {
            show('#view-unlock');
            message($('#unlock-msg'), friendlyError(err), 'error');
            throw err;
        });
    }

    function itemById(id) {
        for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
        return null;
    }

    function render() {
        renderBanner();
        renderGrid();
        updatePublishBar();
    }

    function renderBanner() {
        var strip = $('#banner-strip');
        strip.innerHTML = '';
        state.banner = state.banner.filter(function (id) { var it = itemById(id); return it && it.type === 'photo'; });
        state.banner.forEach(function (id, i) {
            var item = itemById(id);
            var el = document.createElement('div');
            el.className = 'b-thumb';
            el.dataset.id = id;
            var img = document.createElement('img');
            img.src = thumbUrl(item);
            img.alt = item.title || '';
            el.appendChild(img);
            el.insertAdjacentHTML('beforeend', '<span class="num">' + (i + 1) + '</span><button type="button" aria-label="Remove from banner">' + icon('xmark') + '</button>');
            el.querySelector('button').addEventListener('click', function () {
                state.banner = state.banner.filter(function (b) { return b !== id; });
                setDirty();
                render();
            });
            strip.appendChild(el);
        });
    }

    function renderGrid() {
        var grid = $('#grid');
        grid.innerHTML = '';
        var tpl = $('#tpl-tile');
        state.items.forEach(function (item, i) {
            var node = tpl.content.firstElementChild.cloneNode(true);
            node.dataset.id = item.id;
            node.classList.toggle('is-hidden', !!item.hidden);
            var img = node.querySelector('img');
            img.src = thumbUrl(item);
            img.alt = item.title || '';
            node.querySelector('.pos').textContent = i + 1;
            var badge = node.querySelector('.badge');
            if (item.type !== 'photo' || item.hidden) {
                badge.classList.remove('hidden');
                badge.innerHTML = item.hidden ? icon('eye-slash') + ' hidden'
                    : icon(item.type === 'youtube' ? 'youtube' : 'video') + (item.type === 'youtube' ? ' YouTube' : ' video');
            }
            if (item._progress != null) {
                var bar = node.querySelector('.progress');
                bar.classList.remove('hidden');
                bar.firstElementChild.style.width = Math.round(item._progress * 100) + '%';
            }
            var title = node.querySelector('.title');
            title.value = item.title || '';
            title.addEventListener('input', function () { item.title = title.value; setDirty(); });

            var star = node.querySelector('.star');
            if (item.type !== 'photo') star.disabled = true;
            star.classList.toggle('on', state.banner.indexOf(item.id) !== -1);
            star.addEventListener('click', function () {
                var at = state.banner.indexOf(item.id);
                if (at === -1) state.banner.push(item.id); else state.banner.splice(at, 1);
                setDirty();
                render();
            });

            var vis = node.querySelector('.vis');
            vis.innerHTML = icon(item.hidden ? 'eye-slash' : 'eye');
            vis.title = item.hidden ? 'Show in gallery' : 'Hide from gallery';
            vis.addEventListener('click', function () { item.hidden = !item.hidden; setDirty(); render(); });

            node.querySelector('.top').addEventListener('click', function () {
                state.items.splice(state.items.indexOf(item), 1);
                state.items.unshift(item);
                setDirty();
                render();
                window.scrollTo({ top: $('#grid').offsetTop - 80, behavior: 'smooth' });
            });

            node.querySelector('.del').addEventListener('click', function () {
                if (!confirm('Delete "' + (item.title || 'this item') + '" from the website?')) return;
                removeItem(item);
            });
            grid.appendChild(node);
        });
    }

    function removeItem(item) {
        state.items.splice(state.items.indexOf(item), 1);
        state.banner = state.banner.filter(function (b) { return b !== item.id; });
        filesOf(item).forEach(function (path) {
            if (pendingBlobs[path]) delete pendingBlobs[path];   // never published: just forget it
            else pendingDeletes[path] = true;
        });
        if (item._preview) URL.revokeObjectURL(item._preview);
        setDirty();
        render();
    }

    function updatePublishBar() {
        var btn = $('#btn-publish');
        var status = $('#publish-status');
        if (uploading > 0) {
            status.innerHTML = '<strong>Uploading ' + uploading + ' file' + (uploading > 1 ? 's' : '') + '...</strong> please wait';
            btn.disabled = true;
        } else if (dirty) {
            status.innerHTML = '<strong>You have unpublished changes.</strong> Visitors won\'t see them until you publish.';
            btn.disabled = false;
        } else {
            status.textContent = 'Everything is published.';
            btn.disabled = true;
        }
    }

    // Drag to reorder
    Sortable.create($('#grid'), {
        animation: 150,
        handle: '.thumb',
        delay: 200,
        delayOnTouchOnly: true,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        scroll: true,
        bubbleScroll: true,
        onEnd: function () {
            var order = Array.prototype.map.call($('#grid').children, function (el) { return el.dataset.id; });
            state.items.sort(function (a, b) { return order.indexOf(a.id) - order.indexOf(b.id); });
            setDirty();
            render();
        }
    });

    Sortable.create($('#banner-strip'), {
        animation: 150,
        delay: 200,
        delayOnTouchOnly: true,
        ghostClass: 'sortable-ghost',
        filter: 'button',
        preventOnFilter: false,
        onEnd: function () {
            state.banner = Array.prototype.map.call($('#banner-strip').children, function (el) { return el.dataset.id; });
            setDirty();
            render();
        }
    });

    // ---------------------------------------------------------------- uploads

    function canvasToBlob(canvas, type, quality) {
        return new Promise(function (resolve) { canvas.toBlob(resolve, type, quality); });
    }

    function decodeImage(file) {
        if (window.createImageBitmap) {
            return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return viaImg(); });
        }
        return viaImg();
        function viaImg() {
            return new Promise(function (resolve, reject) {
                var url = URL.createObjectURL(file);
                var img = new Image();
                img.onload = function () { resolve(img); };
                img.onerror = function () {
                    URL.revokeObjectURL(url);
                    reject(new Error('"' + file.name + '" could not be read. Please use a JPG or PNG photo.'));
                };
                img.src = url;
            });
        }
    }

    // Resizes a decoded image into each gallery width; prefers WebP, falls back to JPEG (older Safari).
    function makeSizes(source, srcW, srcH) {
        var out = [];
        var chain = Promise.resolve();
        var stop = false;
        WIDTHS.forEach(function (w) {
            chain = chain.then(function () {
                if (stop) return;
                var tw = Math.min(w, srcW);
                var th = Math.round(srcH * tw / srcW);
                var c = document.createElement('canvas');
                c.width = tw; c.height = th;
                var ctx = c.getContext('2d');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, tw, th);
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(source, 0, 0, tw, th);
                return canvasToBlob(c, 'image/webp', QUALITY).then(function (blob) {
                    if (!blob || blob.type !== 'image/webp') return canvasToBlob(c, 'image/jpeg', 0.82);
                    return blob;
                }).then(function (blob) {
                    out.push({ width: w, blob: blob, ext: blob.type === 'image/webp' ? 'webp' : 'jpg' });
                    if (w >= srcW) stop = true;
                });
            });
        });
        return chain.then(function () { return out; });
    }

    function titleFromName(name) {
        var t = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
        if (/^(img|image|dsc|pxl|vid|video|whatsapp)\b/i.test(t) || /^\d/.test(t)) return '';
        return t.charAt(0).toUpperCase() + t.slice(1);
    }

    function uploadSizes(item, sizes, base) {
        var done = 0;
        return sizes.reduce(function (p, s) {
            return p.then(function () {
                return blobToB64(s.blob).then(createBlob).then(function (sha) {
                    pendingBlobs['media/' + base + '-' + s.width + '.' + s.ext] = sha;
                    done++;
                    item._progress = Math.max(item._progress || 0, done / (sizes.length + (item.type === 'video' ? 3 : 0)));
                    renderGrid();
                });
            });
        }, Promise.resolve());
    }

    function addPhoto(file) {
        var item = { id: newId('photo'), type: 'photo', title: titleFromName(file.name), _progress: 0.02 };
        item._preview = URL.createObjectURL(file);
        state.items.unshift(item);
        uploading++;
        setDirty();
        render();
        return decodeImage(file).then(function (src) {
            var w = src.naturalWidth || src.width;
            var h = src.naturalHeight || src.height;
            item.w = w; item.h = h;
            return makeSizes(src, w, h);
        }).then(function (sizes) {
            item.widths = sizes.map(function (s) { return s.width; });
            if (sizes[0].ext !== 'webp') item.ext = sizes[0].ext;
            URL.revokeObjectURL(item._preview);
            item._preview = URL.createObjectURL(sizes[0].blob);
            return uploadSizes(item, sizes, item.id);
        }).then(function () {
            delete item._progress;
        }).catch(function (err) {
            failUpload(item, err);
        }).then(function () {
            uploading--;
            render();
        });
    }

    function videoPoster(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var v = document.createElement('video');
            v.muted = true;
            v.playsInline = true;
            v.preload = 'auto';
            v.src = url;
            var timer = setTimeout(function () { reject(new Error('"' + file.name + '" could not be read in this browser. Try uploading it to YouTube and adding the link instead.')); }, 20000);
            v.onloadedmetadata = function () {
                v.currentTime = Math.min(1, (v.duration || 2) / 2);
            };
            v.onseeked = function () {
                clearTimeout(timer);
                resolve({ video: v, url: url, w: v.videoWidth, h: v.videoHeight });
            };
            v.onerror = function () {
                clearTimeout(timer);
                reject(new Error('"' + file.name + '" can\'t be played in this browser (iPhone videos often use HEVC). Upload it to YouTube and add the link instead, or set iPhone Camera → Formats → Most Compatible.'));
            };
        });
    }

    function addVideo(file) {
        if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
            toast('"' + file.name + '" is ' + Math.round(file.size / 1048576) + ' MB. Videos must be under ' + MAX_VIDEO_MB + ' MB; upload long videos to YouTube and add the link instead.', 'error');
            return Promise.resolve();
        }
        var vext = /\.webm$/i.test(file.name) ? 'webm' : (/\.mov$/i.test(file.name) ? 'mov' : 'mp4');
        var item = { id: newId('video'), type: 'video', title: titleFromName(file.name), _progress: 0.02 };
        if (vext !== 'mp4') item.videoExt = vext;
        state.items.unshift(item);
        uploading++;
        setDirty();
        render();
        var poster;
        return videoPoster(file).then(function (p) {
            poster = p;
            item.w = p.w; item.h = p.h;
            return makeSizes(p.video, p.w, p.h);
        }).then(function (sizes) {
            URL.revokeObjectURL(poster.url);
            var first = sizes.filter(function (s) { return s.width === 960; })[0] || sizes[sizes.length - 1];
            item.widths = [first.width];
            if (first.ext !== 'webp') item.ext = first.ext;
            item._preview = URL.createObjectURL(first.blob);
            renderGrid();
            return uploadSizes(item, [first], item.id + '-poster');
        }).then(function () {
            item._progress = 0.4;
            renderGrid();
            return blobToB64(file);
        }).then(createBlob).then(function (sha) {
            pendingBlobs['media/' + item.id + '.' + vext] = sha;
            delete item._progress;
        }).catch(function (err) {
            failUpload(item, err);
        }).then(function () {
            uploading--;
            render();
        });
    }

    function failUpload(item, err) {
        toast(friendlyError(err), 'error');
        var idx = state.items.indexOf(item);
        if (idx !== -1) state.items.splice(idx, 1);
        filesOf(item).forEach(function (p) { delete pendingBlobs[p]; });
        if (item._preview) URL.revokeObjectURL(item._preview);
    }

    function handleFiles(list) {
        var files = Array.prototype.slice.call(list);
        // Process one at a time (newest ends up first) to keep phones from running out of memory.
        files.reverse().reduce(function (p, file) {
            return p.then(function () {
                if (/^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(file.name)) return addPhoto(file);
                if (/^video\//.test(file.type) || /\.(mp4|mov|webm)$/i.test(file.name)) return addVideo(file);
                toast('"' + file.name + '" is not a photo or video.', 'error');
            });
        }, Promise.resolve());
    }

    $('#file-input').addEventListener('change', function (e) {
        handleFiles(e.target.files);
        e.target.value = '';
    });

    var drop = $('#drop-zone');
    ['dragenter', 'dragover'].forEach(function (t) {
        drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
        drop.addEventListener(t, function () { drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    // YouTube
    $('#btn-youtube').addEventListener('click', function () {
        $('#yt-form').classList.toggle('hidden');
        $('#yt-url').focus();
    });

    function youtubeId(url) {
        var m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/);
        return m ? m[1] : null;
    }

    $('#yt-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var id = youtubeId($('#yt-url').value);
        if (!id) return toast('That does not look like a YouTube link.', 'error');
        state.items.unshift({ id: newId('yt'), type: 'youtube', youtubeId: id, title: $('#yt-title').value.trim() });
        $('#yt-url').value = $('#yt-title').value = '';
        $('#yt-form').classList.add('hidden');
        setDirty();
        render();
    });

    // ---------------------------------------------------------------- publish

    function cleanItems() {
        return state.items.map(function (it) {
            var out = {};
            Object.keys(it).forEach(function (k) { if (k.charAt(0) !== '_' && it[k] !== '' && it[k] !== false && it[k] != null) out[k] = it[k]; });
            if (it.title === '') out.title = '';
            return out;
        });
    }

    function buildTree(baseTreeSha, headSha) {
        var json = JSON.stringify({
            version: 1,
            updated: new Date().toISOString(),
            banner: state.banner,
            items: cleanItems()
        }, null, 1) + '\n';
        var tree = [{ path: GALLERY_PATH, mode: '100644', type: 'blob', content: json }];
        Object.keys(pendingBlobs).forEach(function (path) {
            tree.push({ path: path, mode: '100644', type: 'blob', sha: pendingBlobs[path] });
        });
        var deletes = Object.keys(pendingDeletes);
        // Only delete files that still exist on the branch (someone else may have removed them already).
        var check = deletes.length
            ? gh(repoPath() + '/git/trees/' + headSha + '?recursive=1').then(function (t) {
                var exists = {};
                (t.tree || []).forEach(function (e) { exists[e.path] = true; });
                deletes.forEach(function (path) {
                    if (exists[path]) tree.push({ path: path, mode: '100644', type: 'blob', sha: null });
                });
            })
            : Promise.resolve();
        return check.then(function () {
            return gh(repoPath() + '/git/trees', { method: 'POST', body: { base_tree: baseTreeSha, tree: tree } });
        });
    }

    function commitOnto(headSha) {
        return gh(repoPath() + '/git/commits/' + headSha).then(function (commit) {
            return buildTree(commit.tree.sha, headSha);
        }).then(function (tree) {
            return gh(repoPath() + '/git/commits', {
                method: 'POST',
                body: { message: 'Update gallery from admin page', tree: tree.sha, parents: [headSha] }
            });
        }).then(function (commit) {
            return gh(repoPath() + '/git/refs/heads/' + encodeURIComponent(config.branch), {
                method: 'PATCH', body: { sha: commit.sha, force: false }
            }).then(function () { return commit.sha; });
        });
    }

    $('#btn-publish').addEventListener('click', function () {
        var btn = $('#btn-publish');
        btn.disabled = true;
        $('#publish-status').innerHTML = '<strong>Publishing...</strong>';
        getHead().then(function (head) {
            if (head === baseCommit) return commitOnto(head);
            // The branch moved since this page loaded (e.g. your friend published, or a code update).
            return readRepoFile(GALLERY_PATH, baseCommit).then(function (mine) {
                return readRepoFile(GALLERY_PATH, head).then(function (theirs) {
                    if (mine.sha !== theirs.sha &&
                        !confirm('Someone else changed the gallery while you were editing. Publish anyway and replace their order and titles with yours? (Choose Cancel, then reload the page to see their changes first.)')) {
                        var err = new Error('Not published. Reload the page to see the latest gallery.');
                        throw err;
                    }
                    return commitOnto(head);
                });
            }, function () { return commitOnto(head); });
        }).then(function (newSha) {
            baseCommit = newSha;
            pendingBlobs = {};
            pendingDeletes = {};
            dirty = false;
            updatePublishBar();
            toast('Published! The website will show the changes in about 1 minute.', 'ok');
        }).catch(function (err) {
            updatePublishBar();
            toast(friendlyError(err), 'error');
        });
    });

    window.addEventListener('beforeunload', function (e) {
        if (dirty || uploading) { e.preventDefault(); e.returnValue = ''; }
    });

    // ---------------------------------------------------------------- toast

    var toastTimer;
    function toast(text, kind) {
        var el = $('#toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'toast';
            el.setAttribute('role', 'status');
            el.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);max-width:92%;width:520px;z-index:30;box-shadow:0 6px 20px rgba(0,0,0,.15)';
            document.body.appendChild(el);
        }
        el.textContent = text;
        el.className = 'msg show ' + (kind || 'info');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.className = 'msg'; }, kind === 'error' ? 9000 : 6000);
    }

    if (!window.crypto || !crypto.subtle) {
        show('#view-unlock');
        message($('#unlock-msg'), 'This page must be opened over https (your website address), not from a file on your computer.', 'error');
        return;
    }
    init();
})();
