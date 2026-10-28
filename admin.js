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
    var MAX_VIDEO_MB = 45;          // compressed size limit per video (GitHub allows 100 MB per file)
    var VIDEO_LONG_SIDE = 1280;     // 720p
    var VIDEO_BITRATE = 2500000;    // bits/s for short clips; lowered for long ones to fit MAX_VIDEO_MB
    var MIN_VIDEO_BITRATE = 700000; // below this quality drops too far: use YouTube instead
    var KDF_ITERATIONS = 600000;
    var SESSION_KEY = 'soc-admin-token';
    var NAME_KEY = 'soc-admin-name';

    var $ = function (sel) { return document.querySelector(sel); };
    var enc = new TextEncoder();
    var dec = new TextDecoder();

    var config = null;       // contents of admin-config.json
    var token = null;        // decrypted GitHub token (memory only unless "keep me unlocked")
    var state = null;        // { items: [...], banner: [...] } being edited
    var baseCommit = null;   // commit sha the edit started from
    var pendingBlobs = {};   // path -> blob sha, uploaded but not yet committed
    var pendingDeletes = {}; // path -> true
    var pendingFiles = {};   // path -> new text content (edited pages)
    var uploading = 0;
    var dirty = false;
    var loadedGallery = null; // { ids, json } as published, to describe what changed

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
            pendingFiles = {};
            Pages.reset();
            History.reset();
            loadedGallery = galleryNow();
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
            if (item._label) {
                badge.classList.remove('hidden');
                badge.textContent = item._label;
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
            return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
                // Very large photos (50+ megapixels) are shrunk once here so phones don't run out of memory
                // while making the three web sizes.
                var maxSide = 4096;
                var big = Math.max(bmp.width, bmp.height);
                if (big <= maxSide) return bmp;
                var scale = maxSide / big;
                var c = document.createElement('canvas');
                c.width = Math.round(bmp.width * scale);
                c.height = Math.round(bmp.height * scale);
                var ctx = c.getContext('2d');
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(bmp, 0, 0, c.width, c.height);
                c.naturalWidth = bmp.width;
                c.naturalHeight = bmp.height;
                bmp.close();
                return c;
            }).catch(function () { return viaImg(); });
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

    // Shows progress on one tile without re-rendering the grid (keeps typing in titles smooth).
    function showProgress(item, fraction, label) {
        item._progress = fraction;
        item._label = label;
        var tile = document.querySelector('#grid .tile[data-id="' + item.id + '"]');
        if (!tile) return;
        var bar = tile.querySelector('.progress');
        bar.classList.remove('hidden');
        bar.firstElementChild.style.width = Math.round(fraction * 100) + '%';
        var badge = tile.querySelector('.badge');
        badge.classList.remove('hidden');
        badge.textContent = label;
    }

    var mediabunny = null;
    function loadMediabunny() {
        if (!mediabunny) mediabunny = import('./vendor/mediabunny.min.mjs');
        return mediabunny;
    }

    // Shrinks any camera video (4K, HEVC, hundreds of MB) to a web-friendly 720p H.264 MP4
    // in the browser, sized to fit under MAX_VIDEO_MB. Uses the device's hardware encoder (WebCodecs).
    function compressVideo(file, onProgress) {
        if (!window.VideoEncoder || !window.VideoDecoder) {
            return Promise.reject(new Error('This browser can\'t compress videos. Please use Chrome or Edge on a computer or Android phone, or Safari on an up-to-date iPhone.'));
        }
        return loadMediabunny().then(function (MB) {
            var input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
            return input.computeDuration().then(function (duration) {
                duration = Math.max(duration || 1, 1);
                var audioBits = 128000;
                // Leave ~10% headroom for the MP4 container.
                var budgetBits = MAX_VIDEO_MB * 1024 * 1024 * 8 * 0.9;
                var videoBits = Math.min(VIDEO_BITRATE, Math.floor(budgetBits / duration - audioBits));
                if (videoBits < MIN_VIDEO_BITRATE) {
                    var maxMin = Math.floor(budgetBits / (MIN_VIDEO_BITRATE + audioBits) / 60);
                    throw new Error('"' + file.name + '" is ' + Math.round(duration / 60) + ' minutes long. Videos up to about ' + maxMin + ' minutes can be added here; for longer videos, upload to YouTube and use "Add YouTube video".');
                }
                var output = new MB.Output({
                    format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
                    target: new MB.BufferTarget()
                });
                return MB.Conversion.init({
                    input: input,
                    output: output,
                    tracks: 'primary',
                    video: function (track) {
                        var landscape = track.displayWidth >= track.displayHeight;
                        var longSide = Math.max(track.displayWidth, track.displayHeight);
                        var opts = { codec: 'avc', bitrate: videoBits, frameRate: 30, forceTranscode: true };
                        if (longSide > VIDEO_LONG_SIDE) {
                            if (landscape) opts.width = VIDEO_LONG_SIDE; else opts.height = VIDEO_LONG_SIDE;
                        }
                        return opts;
                    },
                    audio: function (track) {
                        // Camera audio is usually AAC already: copy it as-is. Otherwise re-encode to whatever this browser can.
                        if (track.codec === 'aac') return { codec: 'aac' };
                        return MB.getFirstEncodableAudioCodec(['aac', 'opus']).then(function (codec) {
                            return codec ? { codec: codec, bitrate: audioBits } : { discard: true };
                        });
                    }
                }).then(function (conversion) {
                    var videoKept = conversion.isValid && !conversion.discardedTracks.some(function (d) { return d.track.type === 'video'; });
                    if (!videoKept) {
                        throw new Error('"' + file.name + '" can\'t be compressed in this browser (its video format isn\'t supported here). Try Chrome or Edge on a computer, or upload it to YouTube and add the link.');
                    }
                    var lostAudio = conversion.discardedTracks.some(function (d) { return d.track.type === 'audio'; });
                    conversion.onProgress = function (p) { onProgress(p); };
                    return conversion.execute().then(function () {
                        var blob = new Blob([output.target.buffer], { type: 'video/mp4' });
                        blob.lostAudio = lostAudio;
                        return blob;
                    });
                });
            });
        });
    }

    function keepScreenOn() {
        try {
            if (navigator.wakeLock) return navigator.wakeLock.request('screen').catch(function () { return null; });
        } catch (e) { /* not supported */ }
        return Promise.resolve(null);
    }

    function addVideo(file) {
        var item = { id: newId('video'), type: 'video', title: titleFromName(file.name), _progress: 0.02, _label: 'preparing' };
        state.items.unshift(item);
        uploading++;
        setDirty();
        render();
        var poster, mp4, lock;
        return keepScreenOn().then(function (l) {
            lock = l;
            return compressVideo(file, function (p) {
                showProgress(item, 0.02 + p * 0.68, 'compressing ' + Math.round(p * 100) + '%');
            });
        }).then(function (blob) {
            mp4 = blob;
            showProgress(item, 0.72, 'uploading');
            // Poster comes from the compressed MP4, which every browser can play.
            return videoPoster(mp4);
        }).then(function (p) {
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
            return blobToB64(first.blob).then(createBlob).then(function (sha) {
                pendingBlobs['media/' + item.id + '-poster-' + first.width + '.' + first.ext] = sha;
            });
        }).then(function () {
            showProgress(item, 0.8, 'uploading ' + Math.round(mp4.size / 1048576) + ' MB');
            return blobToB64(mp4);
        }).then(createBlob).then(function (sha) {
            pendingBlobs['media/' + item.id + '.mp4'] = sha;
            delete item._progress;
            delete item._label;
            toast('"' + file.name + '" compressed from ' + Math.round(file.size / 1048576) + ' MB to ' + Math.max(1, Math.round(mp4.size / 1048576)) + ' MB' +
                (mp4.lostAudio ? ', but this browser couldn\'t keep its sound. Try Chrome or Edge if you need the sound.' : '. Press Publish when you\'re ready.'), mp4.lostAudio ? 'error' : 'ok');
        }).catch(function (err) {
            failUpload(item, err);
        }).then(function () {
            if (lock) lock.release().catch(function () {});
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
                if (/\.(cr2|cr3|nef|arw|raf|orf|rw2|dng|pef|srw)$/i.test(file.name)) {
                    toast('"' + file.name + '" is a RAW camera file, which browsers can\'t open. Export it as JPG from your camera app or Lightroom first; any size is fine.', 'error');
                    return;
                }
                if (/^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif|gif|tiff?)$/i.test(file.name)) return addPhoto(file);
                if (/^video\//.test(file.type) || /\.(mp4|m4v|mov|webm|mkv|mts|m2ts)$/i.test(file.name)) return addVideo(file);
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

    // ---------------------------------------------------------------- tabs

    document.querySelectorAll('.tabs .tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            var name = tab.dataset.tab;
            if (name !== 'pages') Pages.apply();
            document.querySelectorAll('.tabs .tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
            ['gallery', 'pages', 'contact', 'history'].forEach(function (n) { $('#tab-' + n).classList.toggle('hidden', n !== name); });
            if (name === 'pages') Pages.open();
            if (name === 'contact') Pages.openContact();
            if (name === 'history') History.open();
        });
    });

    // ---------------------------------------------------------------- page text editor
    //
    // Pages are edited in place: the real page is shown in an iframe, elements marked with
    // data-edit (plain text), data-edit-img (a photo) and data-edit-list/-item (repeatable cards)
    // become editable, and on publish the edits are written back into the page's HTML file.
    // Keys starting with "footer-" are shared by every page, so footer edits apply site-wide.

    var Pages = (function () {
        var PAGES = [
            ['index.html', 'Home'],
            ['gallery.html', 'Gallery'],
            ['contact.html', 'Contact'],
            ['terms.html', 'Terms & Conditions'],
            ['cancellation-policy.html', 'Trip Cancellation Policy'],
            ['404.html', '"Page not found" page']
        ];
        var EXTRA_FILES = ['scripts.js'];
        var src = {};          // path -> latest HTML/JS text, including edits not yet published
        var loading = null;
        var current = null;
        var frameReady = false;
        var frameDirty = false;
        var imgChanges = {};   // data-edit-img key -> new attributes
        var edits = { pages: {}, footer: false, contact: false }; // what changed, for the history note
        var frame = $('#page-frame');
        var select = $('#page-select');

        PAGES.forEach(function (p) {
            var o = document.createElement('option');
            o.value = p[0];
            o.textContent = p[1];
            select.appendChild(o);
        });

        function load() {
            if (!loading) {
                loading = Promise.all(PAGES.map(function (p) { return p[0]; }).concat(EXTRA_FILES).map(function (path) {
                    return readRepoFile(path, baseCommit).then(function (f) { src[path] = f.text; }, function () { /* missing page */ });
                }));
            }
            return loading;
        }

        function reset() {
            loading = null;
            src = {};
            current = null;
            frameReady = false;
            frameDirty = false;
            imgChanges = {};
            clearEdits();
        }

        function clearEdits() { edits = { pages: {}, footer: false, contact: false }; }

        function parse(html) {
            return new DOMParser().parseFromString(html, 'text/html');
        }

        function serialize(doc) {
            return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML + '\n';
        }

        function store(path, text) {
            if (src[path] === text) return;
            src[path] = text;
            pendingFiles[path] = text;
            setDirty();
        }

        function open() {
            show('#view-editor');
            if (current) return;
            frame.srcdoc = '<p style="font-family:sans-serif;padding:20px">Loading pages...</p>';
            load().then(function () { showPage(select.value || 'index.html'); });
        }

        function showPage(path) {
            apply();
            if (!src[path]) {
                toast('Could not load ' + path + '.', 'error');
                return;
            }
            current = path;
            select.value = path;
            frameReady = false;
            imgChanges = {};
            frame.onload = setupFrame;
            frame.srcdoc = src[path];
            var doc = parse(src[path]);
            $('#meta-title').value = doc.title;
            var desc = doc.querySelector('meta[name="description"]');
            $('#meta-desc').value = desc ? desc.getAttribute('content') : '';
        }

        select.addEventListener('change', function () { showPage(select.value); });

        document.querySelectorAll('.seg-btn').forEach(function (b) {
            b.addEventListener('click', function () {
                document.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
                $('#frame-wrap').classList.toggle('phone', b.dataset.view === 'phone');
            });
        });

        ['#meta-title', '#meta-desc'].forEach(function (id) {
            $(id).addEventListener('input', function () { frameDirty = true; setDirty(); });
        });

        var EDIT_CSS =
            '[data-edit]{outline:1px dashed rgba(242,183,5,.9);outline-offset:2px;cursor:text;min-width:1em;display:inline-block}' +
            'p[data-edit],h1[data-edit],h2[data-edit],h3[data-edit],h4[data-edit],li[data-edit]{display:block}' +
            'li[data-edit]{display:list-item}' +
            '[data-edit]:hover{background:rgba(242,183,5,.12)}' +
            '[data-edit]:focus{outline:2px solid #f2b705;background:rgba(242,183,5,.18)}' +
            'img[data-edit-img]{outline:3px dashed #f2b705;outline-offset:-3px;cursor:pointer}' +
            '[data-edit-item]{position:relative}' +
            '.soc-ctl{position:absolute;top:6px;right:6px;display:flex;gap:6px;z-index:5}' +
            '.soc-ctl button{font:600 12px/1 "Segoe UI",sans-serif;padding:6px 9px;border-radius:5px;border:0;cursor:pointer;background:#2b3a42;color:#fff}' +
            '.soc-ctl button.rm{background:#c0392b}' +
            '.soc-img-tip{position:absolute;left:10px;top:10px;background:#f2b705;color:#2b3a42;font:600 12px "Segoe UI",sans-serif;padding:4px 8px;border-radius:5px;pointer-events:none}';

        function makeEditable(doc, root) {
            root.querySelectorAll('[data-edit]').forEach(function (el) {
                el.setAttribute('contenteditable', 'plaintext-only');
                if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
                el.setAttribute('spellcheck', 'true');
            });
            root.querySelectorAll('[data-edit-item]').forEach(function (item) { addControls(doc, item); });
        }

        function addControls(doc, item) {
            if (item.querySelector(':scope > .soc-ctl')) return;
            var ctl = doc.createElement('div');
            ctl.className = 'soc-ctl';
            ctl.innerHTML = '<button type="button" class="cp">+ Copy</button><button type="button" class="rm">Remove</button>';
            ctl.querySelector('.cp').addEventListener('click', function () {
                var clone = item.cloneNode(true);
                var c = clone.querySelector(':scope > .soc-ctl');
                if (c) c.remove();
                clone.querySelectorAll('[data-edit]').forEach(function (el) {
                    el.setAttribute('data-edit', current.replace(/\.html$/, '') + '-n' + Math.random().toString(36).slice(2, 8));
                });
                item.after(clone);
                makeEditable(doc, clone);
                addControls(doc, clone);
                var first = clone.querySelector('[data-edit]');
                if (first) first.focus();
                frameDirty = true;
                setDirty();
            });
            ctl.querySelector('.rm').addEventListener('click', function () {
                var list = item.parentNode;
                if (list.querySelectorAll(':scope > [data-edit-item]').length <= 1 &&
                    !confirm('This is the last one in this section. Remove it anyway?')) return;
                if (!confirm('Remove this card?')) return;
                item.remove();
                frameDirty = true;
                setDirty();
            });
            item.appendChild(ctl);
        }

        function setupFrame() {
            var doc = frame.contentDocument;
            if (!doc || !doc.body || !current) return;
            var style = doc.createElement('style');
            style.textContent = EDIT_CSS;
            doc.head.appendChild(style);
            makeEditable(doc, doc);

            doc.addEventListener('input', function () { frameDirty = true; setDirty(); });
            doc.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && e.target.closest && e.target.closest('[data-edit]')) e.preventDefault();
            });
            doc.addEventListener('paste', function (e) {
                var el = e.target.closest && e.target.closest('[data-edit]');
                if (!el || el.getAttribute('contenteditable') === 'plaintext-only') return;
                e.preventDefault();
                var text = (e.clipboardData || window.clipboardData).getData('text/plain').replace(/\s+/g, ' ');
                doc.execCommand('insertText', false, text);
            });
            // Links and buttons shouldn't navigate or submit while editing.
            doc.addEventListener('click', function (e) {
                if (e.target.closest('.soc-ctl')) return;
                var img = e.target.closest('img[data-edit-img]');
                if (img) { e.preventDefault(); pickImage(img); return; }
                if (e.target.closest('a, button, .gallery-item')) { e.preventDefault(); e.stopPropagation(); }
            }, true);
            doc.addEventListener('submit', function (e) { e.preventDefault(); }, true);
            frameReady = true;
        }

        var imgTarget = null;
        function pickImage(img) {
            imgTarget = img;
            $('#img-input').click();
        }

        $('#img-input').addEventListener('change', function (e) {
            var file = e.target.files[0];
            e.target.value = '';
            if (!file || !imgTarget) return;
            var img = imgTarget;
            var key = img.getAttribute('data-edit-img');
            var id = newId('page');
            toast('Preparing photo...', 'info');
            uploading++;
            updatePublishBar();
            decodeImage(file).then(function (s) {
                var w = s.naturalWidth || s.width, h = s.naturalHeight || s.height;
                return makeSizes(s, w, h).then(function (sizes) { return { sizes: sizes, w: w, h: h }; });
            }).then(function (r) {
                return r.sizes.reduce(function (p, s) {
                    return p.then(function () {
                        return blobToB64(s.blob).then(createBlob).then(function (sha) {
                            pendingBlobs['media/' + id + '-' + s.width + '.' + s.ext] = sha;
                        });
                    });
                }, Promise.resolve()).then(function () { return r; });
            }).then(function (r) {
                var ext = r.sizes[0].ext;
                var mid = r.sizes.filter(function (s) { return s.width === 960; })[0] || r.sizes[r.sizes.length - 1];
                var attrs = {
                    src: 'media/' + id + '-' + mid.width + '.' + ext,
                    srcset: r.sizes.map(function (s) { return 'media/' + id + '-' + s.width + '.' + ext + ' ' + Math.min(s.width, r.w) + 'w'; }).join(', '),
                    width: String(Math.min(mid.width, r.w)),
                    height: String(Math.round(r.h * Math.min(mid.width, r.w) / r.w))
                };
                imgChanges[key] = attrs;
                // Preview with the local file (the uploaded copies aren't on the site yet).
                img.removeAttribute('srcset');
                img.src = URL.createObjectURL(mid.blob);
                frameDirty = true;
                setDirty();
                toast('Photo replaced. Press Publish when you\'re ready.', 'ok');
            }).catch(function (err) {
                toast(friendlyError(err), 'error');
            }).then(function () {
                uploading--;
                updatePublishBar();
            });
        });

        function cleanList(node) {
            var copy = node.cloneNode(true);
            copy.querySelectorAll('.soc-ctl').forEach(function (c) { c.remove(); });
            copy.querySelectorAll('[contenteditable]').forEach(function (el) {
                el.removeAttribute('contenteditable');
                el.removeAttribute('spellcheck');
            });
            return copy.innerHTML;
        }

        function textOf(el) {
            return el.textContent.replace(/\s+/g, ' ').trim();
        }

        // Writes the edits made in the iframe back into the page's HTML (and footer edits into every page).
        function apply() {
            if (!current || !frameReady || !frameDirty) return;
            var fdoc = frame.contentDocument;
            var doc = parse(src[current]);
            var texts = {};
            fdoc.querySelectorAll('[data-edit]').forEach(function (el) { texts[el.getAttribute('data-edit')] = textOf(el); });

            var fLists = fdoc.querySelectorAll('[data-edit-list]');
            doc.querySelectorAll('[data-edit-list]').forEach(function (list, i) {
                if (fLists[i]) list.innerHTML = cleanList(fLists[i]);
            });
            doc.querySelectorAll('[data-edit]').forEach(function (el) {
                var k = el.getAttribute('data-edit');
                if (k in texts && textOf(el) !== texts[k]) el.textContent = texts[k];
            });
            Object.keys(imgChanges).forEach(function (key) {
                var img = doc.querySelector('img[data-edit-img="' + key + '"]');
                if (!img) return;
                Object.keys(imgChanges[key]).forEach(function (a) { img.setAttribute(a, imgChanges[key][a]); });
            });
            imgChanges = {};

            var title = $('#meta-title').value.trim();
            var desc = $('#meta-desc').value.trim();
            if (title && title !== doc.title) {
                doc.title = title;
                setMeta(doc, 'property', 'og:title', title);
            }
            var dm = doc.querySelector('meta[name="description"]');
            if (dm && desc && dm.getAttribute('content') !== desc) {
                dm.setAttribute('content', desc);
                setMeta(doc, 'property', 'og:description', desc);
            }

            var out = serialize(doc);
            if (out !== serialize(parse(src[current]))) { store(current, out); edits.pages[current] = true; }

            // Footer is shared: copy footer edits to the other pages.
            var footer = {};
            Object.keys(texts).forEach(function (k) { if (/^footer-/.test(k)) footer[k] = texts[k]; });
            PAGES.forEach(function (p) {
                var path = p[0];
                if (path === current || !src[path]) return;
                var d = parse(src[path]);
                var changed = false;
                d.querySelectorAll('footer [data-edit]').forEach(function (el) {
                    var k = el.getAttribute('data-edit');
                    if (k in footer && textOf(el) !== footer[k]) { el.textContent = footer[k]; changed = true; }
                });
                if (changed) { store(path, serialize(d)); edits.footer = true; }
            });
            frameDirty = false;
        }

        function setMeta(doc, attr, name, value) {
            var m = doc.querySelector('meta[' + attr + '="' + name + '"]');
            if (m) m.setAttribute('content', value);
        }

        // ---- contact details (string replacement across all pages + scripts.js)

        var contact = null;

        function detectContact() { return contactOf(src['index.html'] || ''); }

        function contactOf(html) {
            var tel = (html.match(/href="tel:\+?(\d+)"/) || [])[1] || '';
            var phoneText = (html.match(/href="tel:[^"]*"[^>]*>([^<]+)</) || [])[1] || '';
            var wa = (html.match(/wa\.me\/(\d+)/) || [])[1] || '';
            var email = (html.match(/href="mailto:([^"]+)"/) || [])[1] || '';
            var insta = (html.match(/href="(https:\/\/(?:www\.)?instagram\.com\/[^"]*)"/) || [])[1] || '';
            var yt = (html.match(/href="(https:\/\/(?:www\.)?youtube\.com\/[^"]*)"/) || [])[1] || '';
            return { tel: tel, phoneText: phoneText, wa: wa, email: email, insta: insta, yt: yt };
        }

        function openContact() {
            load().then(function () {
                apply();
                contact = detectContact();
                $('#c-phone').value = contact.phoneText;
                $('#c-wa').value = contact.wa ? '+' + contact.wa : '';
                $('#c-email').value = contact.email;
                $('#c-insta').value = contact.insta;
                $('#c-yt').value = contact.yt;
            });
        }

        function replaceAll(text, from, to) {
            if (!from || from === to) return text;
            return text.split(from).join(to);
        }

        function swapContact(t, from, to) {
            t = replaceAll(t, 'tel:+' + from.tel, 'tel:+' + to.tel);
            t = replaceAll(t, 'tel:' + from.tel, 'tel:+' + to.tel);
            t = replaceAll(t, from.phoneText, to.phoneText);
            t = replaceAll(t, 'wa.me/' + from.wa, 'wa.me/' + to.wa);
            t = replaceAll(t, from.email, to.email);
            if (to.insta) t = replaceAll(t, from.insta, to.insta);
            if (to.yt) t = replaceAll(t, from.yt, to.yt);
            return t;
        }

        function label(path) {
            var p = PAGES.filter(function (x) { return x[0] === path; })[0];
            return p ? p[1] : path;
        }

        $('#form-contact').addEventListener('submit', function (e) {
            e.preventDefault();
            if (!contact) return;
            var phoneText = $('#c-phone').value.trim();
            var tel = phoneText.replace(/\D/g, '');
            var wa = $('#c-wa').value.replace(/\D/g, '');
            var email = $('#c-email').value.trim();
            var insta = $('#c-insta').value.trim();
            var yt = $('#c-yt').value.trim();
            if (tel.length < 10 || wa.length < 10) return toast('Please enter full phone numbers with the country code, e.g. +91 6360250855.', 'error');
            if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Please enter a valid email address.', 'error');
            apply();
            var files = PAGES.map(function (p) { return p[0]; }).concat(EXTRA_FILES);
            var changed = 0;
            var next = { tel: tel, phoneText: phoneText, wa: wa, email: email, insta: insta || contact.insta, yt: yt || contact.yt };
            files.forEach(function (path) {
                if (!src[path]) return;
                var t = swapContact(src[path], contact, next);
                if (t !== src[path]) { store(path, t); changed++; }
            });
            if (changed) edits.contact = true;
            contact = detectContact();
            if (current) { var keep = current; current = null; showPage(keep); }
            toast(changed ? 'Contact details updated on ' + changed + ' files. Press Publish to put them live.' : 'Nothing changed.', changed ? 'ok' : 'info');
        });

        return {
            open: open, apply: apply, reset: reset, openContact: openContact,
            paths: PAGES.map(function (p) { return p[0]; }), label: label,
            edits: function () { return edits; }, clearEdits: clearEdits,
            contactOf: contactOf, swapContact: swapContact
        };
    })();

    // ---------------------------------------------------------------- history / restore
    //
    // Every publish is a git commit, so the history is the branch's commit list. "Restore" makes a
    // NEW commit that puts back the gallery, photos/videos, page text and contact details as they
    // were in an older version. The site's code (admin page, scripts, styles) and the admin key stay
    // as they are now, and the restore itself shows up in the history, so it can be undone too.

    var History = (function () {
        var PER_PAGE = 20;
        var list = $('#history-list');
        var more = $('#history-more');
        var page = 0;
        var loaded = false;
        var busy = false;
        var nameInput = $('#publisher-name');

        nameInput.value = publisher();
        nameInput.addEventListener('input', function () {
            try { localStorage.setItem(NAME_KEY, nameInput.value.trim()); } catch (e) { /* private mode */ }
        });

        function reset() {
            loaded = false;
            page = 0;
            list.innerHTML = '';
        }

        function open() {
            if (!loaded) { loaded = true; loadMore(); }
        }

        function when(iso) {
            return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        }

        // Split a commit message into what to show: title, details, who published it.
        function describe(message) {
            var lines = message.split('\n');
            var who = '';
            var admin = /\(admin page\)\s*$/.test(message) || /^(Update gallery|Update website) from admin page/.test(message);
            var body = lines.slice(1).filter(function (l) {
                var m = l.match(/^Published by: (.+)$/);
                if (m) { who = m[1]; return false; }
                return l.trim() && l.trim() !== '(admin page)' && !/^(Co-Authored-By|Claude-Session):/i.test(l);
            });
            var title = lines[0];
            if (/^Update gallery from admin page$/.test(title)) title = 'Gallery update';
            if (/^Update website from admin page$/.test(title)) title = 'Website update';
            return { title: title, details: admin ? body.join(' ') : '', who: who, admin: admin };
        }

        function loadMore() {
            page++;
            more.disabled = true;
            more.textContent = 'Loading...';
            gh(repoPath() + '/commits?sha=' + encodeURIComponent(config.branch) + '&per_page=' + PER_PAGE + '&page=' + page).then(function (commits) {
                commits.forEach(function (c, i) { list.appendChild(row(c, page === 1 && i === 0)); });
                more.classList.toggle('hidden', commits.length < PER_PAGE);
                if (page === 1 && !commits.length) list.innerHTML = '<p class="hint">No versions yet.</p>';
            }).catch(function (err) {
                page--;
                toast(friendlyError(err), 'error');
            }).then(function () {
                more.disabled = false;
                more.textContent = 'Show older versions';
            });
        }

        function row(c, live) {
            var d = describe(c.commit.message);
            var el = document.createElement('div');
            el.className = 'version';
            el.innerHTML =
                '<div class="v-main"><div class="v-title"></div><div class="v-details hint"></div>' +
                '<div class="v-meta"></div></div>' +
                '<div class="v-actions"><a class="v-link" target="_blank" rel="noopener">See changes</a></div>';
            el.querySelector('.v-title').textContent = d.title;
            el.querySelector('.v-details').textContent = d.details;
            el.querySelector('.v-meta').textContent = when(c.commit.author.date) +
                (d.who ? ' · by ' + d.who : (d.admin ? '' : ' · website code update'));
            el.querySelector('.v-link').href = c.html_url;
            var actions = el.querySelector('.v-actions');
            if (live) {
                var tag = document.createElement('span');
                tag.className = 'v-live';
                tag.textContent = 'Live now';
                actions.insertBefore(tag, actions.firstChild);
            } else {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'btn secondary';
                b.textContent = 'Restore';
                b.addEventListener('click', function () { restore(c, d, b); });
                actions.insertBefore(b, actions.firstChild);
            }
            return el;
        }

        function treeMap(commitSha) {
            return gh(repoPath() + '/git/commits/' + commitSha).then(function (commit) {
                return gh(repoPath() + '/git/trees/' + commit.tree.sha + '?recursive=1').then(function (t) {
                    var map = {};
                    (t.tree || []).forEach(function (e) { if (e.type === 'blob') map[e.path] = e; });
                    return { treeSha: commit.tree.sha, files: map };
                });
            });
        }

        function blobText(sha) {
            return gh(repoPath() + '/git/blobs/' + sha).then(function (b) { return dec.decode(bytesFromB64(b.content.replace(/\s/g, ''))); });
        }

        function restore(c, d, btn) {
            if (busy) return;
            var date = when(c.commit.author.date);
            var ask = 'Put the website back to how it was on ' + date + '?\n\n' +
                'Photos, videos, gallery order, page text and contact details will go back to that version. ' +
                'This is saved as a new version, so you can undo it from this list.';
            if (dirty) ask += '\n\nYour unpublished changes on this page will be lost.';
            if (!confirm(ask)) return;
            busy = true;
            btn.disabled = true;
            btn.textContent = 'Restoring...';
            var head, now, old, pagesOk = true;
            getHead().then(function (h) {
                head = h;
                return Promise.all([treeMap(head), treeMap(c.sha)]);
            }).then(function (r) {
                now = r[0];
                old = r[1];
                if (!old.files[GALLERY_PATH]) throw new Error('This version is from before the new website, so it can\'t be restored here.');
                // Page text can only go back to versions made after page editing was added,
                // otherwise the pages would lose their editable markers.
                var idx = old.files['index.html'];
                return idx ? blobText(idx.sha).then(function (t) { pagesOk = t.indexOf('data-edit') !== -1; return t; }) : (pagesOk = false);
            }).then(function (oldIndex) {
                var restorable = function (path) {
                    return path === GALLERY_PATH || /^media\//.test(path) || (pagesOk && Pages.paths.indexOf(path) !== -1);
                };
                var tree = [];
                Object.keys(old.files).forEach(function (path) {
                    var e = old.files[path];
                    if (restorable(path) && (!now.files[path] || now.files[path].sha !== e.sha)) {
                        tree.push({ path: path, mode: e.mode, type: 'blob', sha: e.sha });
                    }
                });
                Object.keys(now.files).forEach(function (path) {
                    if (restorable(path) && !old.files[path]) tree.push({ path: path, mode: '100644', type: 'blob', sha: null });
                });
                // Contact details also live in scripts.js (booking form -> WhatsApp).
                var js = now.files['scripts.js'];
                var contactStep = (!pagesOk || !js || !now.files['index.html']) ? Promise.resolve() :
                    Promise.all([blobText(now.files['index.html'].sha), blobText(js.sha)]).then(function (t) {
                        var from = Pages.contactOf(t[0]);
                        var to = Pages.contactOf(oldIndex);
                        if (!to.tel || !to.wa || !to.email) return;
                        var next = Pages.swapContact(t[1], from, to);
                        if (next !== t[1]) tree.push({ path: 'scripts.js', mode: '100644', type: 'blob', content: next });
                    });
                return contactStep.then(function () { return tree; });
            }).then(function (tree) {
                if (!tree.length) throw new Error('That version looks the same as the live website, so there was nothing to restore.');
                return gh(repoPath() + '/git/trees', { method: 'POST', body: { base_tree: now.treeSha, tree: tree } });
            }).then(function (t) {
                var msg = 'Restore version from ' + date + ' (' + d.title + ')';
                var who = publisher();
                if (who) msg += '\n\nPublished by: ' + who;
                return gh(repoPath() + '/git/commits', { method: 'POST', body: { message: msg + '\n\n(admin page)', tree: t.sha, parents: [head] } });
            }).then(function (commit) {
                return gh(repoPath() + '/git/refs/heads/' + encodeURIComponent(config.branch), { method: 'PATCH', body: { sha: commit.sha, force: false } });
            }).then(function () {
                dirty = false;
                return openEditor();
            }).then(function () {
                reset();
                open();
                toast(pagesOk
                    ? 'Restored. The website will show that version in about 1 minute.'
                    : 'Photos and videos restored. Page text was kept as it is now, because that version is older than page editing. The website updates in about 1 minute.', 'ok');
            }).catch(function (err) {
                btn.disabled = false;
                btn.textContent = 'Restore';
                toast(friendlyError(err), 'error');
            }).then(function () { busy = false; });
        }

        more.addEventListener('click', loadMore);

        return { open: open, reset: reset };
    })();

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
        Object.keys(pendingFiles).forEach(function (path) {
            tree.push({ path: path, mode: '100644', type: 'blob', content: pendingFiles[path] });
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

    function galleryNow() {
        return {
            ids: state.items.map(function (it) { return it.id; }),
            json: JSON.stringify({ banner: state.banner, items: cleanItems() })
        };
    }

    // "Added 2 photos/videos, changed the order. Edited pages: Home, Contact."
    function changeSummary() {
        var parts = [];
        var now = galleryNow();
        var was = loadedGallery || { ids: [], json: '' };
        var added = now.ids.filter(function (id) { return was.ids.indexOf(id) === -1; }).length;
        var removed = was.ids.filter(function (id) { return now.ids.indexOf(id) === -1; }).length;
        if (added) parts.push('added ' + added + ' photo' + (added > 1 ? 's/videos' : '/video'));
        if (removed) parts.push('removed ' + removed);
        var keptNow = now.ids.filter(function (id) { return was.ids.indexOf(id) !== -1; });
        var keptWas = was.ids.filter(function (id) { return now.ids.indexOf(id) !== -1; });
        if (keptNow.join() !== keptWas.join()) parts.push('changed the order');
        else if (!added && !removed && now.json !== was.json) parts.push('changed gallery titles or banner');
        var text = parts.length ? 'Gallery: ' + parts.join(', ') + '.' : '';
        var e = Pages.edits();
        var pages = Object.keys(e.pages).map(Pages.label);
        var more = [];
        if (pages.length) more.push('edited ' + pages.join(', ') + ' page' + (pages.length > 1 ? 's' : ''));
        if (e.footer) more.push('edited the footer');
        if (e.contact) more.push('changed contact details');
        if (more.length) text += (text ? ' ' : '') + 'Pages: ' + more.join(', ') + '.';
        return text || 'Website update.';
    }

    function publisher() {
        try { return (localStorage.getItem(NAME_KEY) || '').trim(); } catch (e) { return ''; }
    }

    function commitMessage(first) {
        var note = $('#publish-note').value.trim();
        var msg = first || (note ? note : changeSummary());
        if (!first && note) msg += '\n\n' + changeSummary();
        var who = publisher();
        if (who) msg += '\n\nPublished by: ' + who;
        return msg + '\n\n(admin page)';
    }

    function commitOnto(headSha) {
        return gh(repoPath() + '/git/commits/' + headSha).then(function (commit) {
            return buildTree(commit.tree.sha, headSha);
        }).then(function (tree) {
            return gh(repoPath() + '/git/commits', {
                method: 'POST',
                body: { message: commitMessage(), tree: tree.sha, parents: [headSha] }
            });
        }).then(function (commit) {
            return gh(repoPath() + '/git/refs/heads/' + encodeURIComponent(config.branch), {
                method: 'PATCH', body: { sha: commit.sha, force: false }
            }).then(function () { return commit.sha; });
        });
    }

    $('#btn-publish').addEventListener('click', function () {
        var btn = $('#btn-publish');
        Pages.apply();
        btn.disabled = true;
        $('#publish-status').innerHTML = '<strong>Publishing...</strong>';
        getHead().then(function (head) {
            if (head === baseCommit) return head;
            var edited = Object.keys(pendingFiles);
            if (!edited.length) return head;
            // Page edits replace whole files, so make sure nobody changed those files in the meantime.
            return gh(repoPath() + '/compare/' + baseCommit + '...' + head).then(function (cmp) {
                var clash = (cmp.files || []).some(function (f) { return edited.indexOf(f.filename) !== -1; });
                if (clash) throw new Error('The website pages were updated by someone else while you were editing. Copy your text somewhere, reload this page, and make your page edits again.');
                return head;
            });
        }).then(function (head) {
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
            pendingFiles = {};
            loadedGallery = galleryNow();
            Pages.clearEdits();
            $('#publish-note').value = '';
            History.reset();
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
