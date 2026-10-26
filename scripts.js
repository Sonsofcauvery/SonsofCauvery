/* Sons of Cauvery - site scripts.
 * Gallery, banners and the home-page preview are all built from data/gallery.json,
 * which the admin page (admin.html) edits. No source changes are needed to add photos. */
(function () {
    'use strict';

    var DATA_URL = 'data/gallery.json';
    var SLIDE_INTERVAL = 5000;

    function icon(name) {
        return '<svg class="icon" aria-hidden="true"><use href="icons.svg#' + name + '"></use></svg>';
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---- Media URLs -------------------------------------------------------

    function imageBase(item) {
        return item.type === 'video' ? item.id + '-poster' : item.id;
    }

    function imageSrc(item, width) {
        if (item.type === 'youtube') {
            return 'https://i.ytimg.com/vi/' + item.youtubeId + '/' + (width > 480 ? 'maxresdefault' : 'hqdefault') + '.jpg';
        }
        var widths = item.widths || [960];
        var w = widths[widths.length - 1];
        for (var i = 0; i < widths.length; i++) {
            if (widths[i] >= width) { w = widths[i]; break; }
        }
        return 'media/' + imageBase(item) + '-' + w + '.' + (item.ext || 'webp');
    }

    function imageSrcset(item) {
        if (item.type === 'youtube') return '';
        return (item.widths || [960]).map(function (w) {
            return 'media/' + imageBase(item) + '-' + w + '.' + (item.ext || 'webp') + ' ' + Math.min(w, item.w || w) + 'w';
        }).join(', ');
    }

    function isVideo(item) {
        return item.type === 'video' || item.type === 'youtube';
    }

    // ---- Data -------------------------------------------------------------

    var dataPromise = (window.__gallery || fetch(DATA_URL, { cache: 'no-cache' }).then(function (r) { return r.json(); }))
        .then(function (data) {
            data.items = (data.items || []).filter(function (it) { return it && it.id; });
            return data;
        });

    // ---- Navigation -------------------------------------------------------

    function initNav() {
        var toggle = document.querySelector('.menu-toggle');
        var menu = document.querySelector('.nav-menu');
        if (!toggle || !menu) return;
        function set(open) {
            menu.classList.toggle('active', open);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        toggle.addEventListener('click', function () { set(!menu.classList.contains('active')); });
        menu.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { set(false); }); });
    }

    // ---- Banner slideshow ---------------------------------------------------

    function initBanner(data) {
        var holder = document.querySelector('[data-banner]');
        if (!holder) return;
        var byId = {};
        data.items.forEach(function (it) { byId[it.id] = it; });
        var slides = (data.banner || []).map(function (id) { return byId[id]; })
            .filter(function (it) { return it && it.type === 'photo'; });
        if (!slides.length) slides = data.items.filter(function (it) { return it.type === 'photo'; }).slice(0, 1);
        if (!slides.length) return;

        var imgs = slides.map(function (item, i) {
            var img = document.createElement('img');
            img.className = 'hero-slide';
            img.alt = '';
            img.sizes = '100vw';
            img.decoding = 'async';
            if (i === 0) {
                img.setAttribute('fetchpriority', 'high');
                load(img, item);
            }
            img._item = item;
            holder.appendChild(img);
            return img;
        });

        function load(img, item) {
            if (img._loading) return img._loading;
            img._loading = new Promise(function (resolve) {
                img.onload = img.onerror = function () { resolve(); };
                img.srcset = imageSrcset(item);
                img.src = imageSrc(item, 1920);
            });
            return img._loading;
        }

        imgs[0]._loading.then(function () { imgs[0].classList.add('active'); });
        if (imgs.length < 2) return;

        var current = 0;
        var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduceMotion) return;

        function next() {
            var n = (current + 1) % imgs.length;
            load(imgs[n], imgs[n]._item).then(function () {
                imgs[current].classList.remove('active');
                imgs[n].classList.add('active');
                current = n;
                // Fetch the slide after this one ahead of time.
                var after = (n + 1) % imgs.length;
                load(imgs[after], imgs[after]._item);
                setTimeout(next, SLIDE_INTERVAL);
            });
        }
        // Start pre-loading slide 2 only once the page has finished loading.
        window.addEventListener('load', function () { load(imgs[1], imgs[1]._item); });
        setTimeout(next, SLIDE_INTERVAL);
    }

    // ---- Gallery grid -------------------------------------------------------

    function buildTile(item, index) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gallery-item ' + (isVideo(item) ? 'video' : 'photo');
        btn.dataset.index = index;
        btn.setAttribute('aria-label', (isVideo(item) ? 'Play video: ' : 'View photo: ') + (item.title || 'Sons of Cauvery'));
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = item.title || 'Sons of Cauvery';
        img.sizes = '(max-width: 768px) 50vw, (max-width: 1200px) 33vw, 300px';
        var srcset = imageSrcset(item);
        if (srcset) img.srcset = srcset;
        img.src = imageSrc(item, 480);
        img.addEventListener('load', function () { img.classList.add('loaded'); });
        img.addEventListener('error', function () { img.classList.add('loaded'); });
        if (img.complete) img.classList.add('loaded');
        btn.appendChild(img);
        if (isVideo(item)) {
            btn.insertAdjacentHTML('beforeend', '<span class="play"><span>' + icon('play') + '</span></span>');
        }
        if (item.title) {
            btn.insertAdjacentHTML('beforeend', '<span class="caption">' + escapeHtml(item.title) + '</span>');
        }
        return btn;
    }

    function initGalleries(data) {
        document.querySelectorAll('[data-gallery]').forEach(function (grid) {
            var limit = parseInt(grid.dataset.limit, 10) || 0;
            var items = data.items.filter(function (it) { return !it.hidden; });
            if (limit) items = items.slice(0, limit);
            grid.innerHTML = '';
            if (!items.length) {
                grid.innerHTML = '<p class="gallery-empty">Photos coming soon.</p>';
                return;
            }
            var frag = document.createDocumentFragment();
            items.forEach(function (item, i) { frag.appendChild(buildTile(item, i)); });
            grid.appendChild(frag);

            var visible = items;
            grid.addEventListener('click', function (e) {
                var tile = e.target.closest('.gallery-item');
                if (!tile) return;
                var item = items[+tile.dataset.index];
                Lightbox.open(visible, visible.indexOf(item));
            });

            // Filter tabs (gallery page only)
            var section = grid.closest('section');
            var tabs = section ? section.querySelectorAll('.tab-btn') : [];
            tabs.forEach(function (tab) {
                tab.addEventListener('click', function () {
                    tabs.forEach(function (t) { t.classList.toggle('active', t === tab); });
                    var f = tab.dataset.filter;
                    visible = items.filter(function (it) {
                        return f === 'all' || (f === 'video' ? isVideo(it) : !isVideo(it));
                    });
                    grid.querySelectorAll('.gallery-item').forEach(function (el) {
                        var it = items[+el.dataset.index];
                        el.classList.toggle('is-hidden', visible.indexOf(it) === -1);
                    });
                });
            });
        });
    }

    // ---- Lightbox -----------------------------------------------------------

    var Lightbox = (function () {
        var root, stage, mediaBox, caption, counter, list = [], index = 0, isOpen = false;

        function build() {
            root = document.createElement('div');
            root.className = 'lightbox';
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-modal', 'true');
            root.setAttribute('aria-label', 'Gallery viewer');
            root.innerHTML =
                '<div class="lb-top"><span class="lb-counter"></span>' +
                '<button class="lb-btn lb-close" aria-label="Close">' + icon('xmark') + '</button></div>' +
                '<div class="lb-stage">' +
                '<button class="lb-btn lb-prev" aria-label="Previous">' + icon('chevron-left') + '</button>' +
                '<div class="lb-media"></div>' +
                '<button class="lb-btn lb-next" aria-label="Next">' + icon('chevron-right') + '</button>' +
                '</div><div class="lb-caption"></div>';
            document.body.appendChild(root);
            stage = root.querySelector('.lb-stage');
            mediaBox = root.querySelector('.lb-media');
            caption = root.querySelector('.lb-caption');
            counter = root.querySelector('.lb-counter');
            root.querySelector('.lb-close').addEventListener('click', close);
            root.querySelector('.lb-prev').addEventListener('click', function () { go(-1); });
            root.querySelector('.lb-next').addEventListener('click', function () { go(1); });
            mediaBox.addEventListener('click', function (e) { if (e.target === mediaBox) close(); });

            var startX = null, startY = null;
            stage.addEventListener('touchstart', function (e) {
                startX = e.touches[0].clientX; startY = e.touches[0].clientY;
            }, { passive: true });
            stage.addEventListener('touchend', function (e) {
                if (startX === null) return;
                var dx = e.changedTouches[0].clientX - startX;
                var dy = e.changedTouches[0].clientY - startY;
                if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
                else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) close();
                startX = null;
            });

            document.addEventListener('keydown', function (e) {
                if (!isOpen) return;
                if (e.key === 'Escape') close();
                else if (e.key === 'ArrowRight') go(1);
                else if (e.key === 'ArrowLeft') go(-1);
            });
            window.addEventListener('popstate', function () { if (isOpen) hide(); });
        }

        function render() {
            var item = list[index];
            mediaBox.innerHTML = '';
            caption.textContent = item.title || '';
            counter.textContent = (index + 1) + ' / ' + list.length;
            var multi = list.length > 1;
            root.querySelector('.lb-prev').style.visibility = multi ? '' : 'hidden';
            root.querySelector('.lb-next').style.visibility = multi ? '' : 'hidden';

            if (item.type === 'youtube') {
                var iframe = document.createElement('iframe');
                iframe.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(item.youtubeId) + '?autoplay=1&rel=0&playsinline=1';
                iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
                iframe.allowFullscreen = true;
                iframe.title = item.title || 'Video';
                mediaBox.appendChild(iframe);
            } else if (item.type === 'video') {
                var v = document.createElement('video');
                v.controls = true;
                v.playsInline = true;
                v.autoplay = true;
                v.preload = 'auto';
                v.poster = imageSrc(item, 960);
                v.src = 'media/' + item.id + '.' + (item.videoExt || 'mp4');
                v.setAttribute('controlsList', 'nodownload');
                mediaBox.appendChild(v);
            } else {
                var spinner = document.createElement('div');
                spinner.className = 'lb-spinner';
                mediaBox.appendChild(spinner);
                var img = new Image();
                img.alt = item.title || '';
                img.sizes = '100vw';
                img.srcset = imageSrcset(item);
                img.src = imageSrc(item, 1920);
                img.onload = img.onerror = function () { spinner.remove(); };
                mediaBox.appendChild(img);
                preload(index + 1);
                preload(index - 1);
            }
        }

        function preload(i) {
            var item = list[(i + list.length) % list.length];
            if (!item || item.type !== 'photo') return;
            var img = new Image();
            img.sizes = '100vw';
            img.srcset = imageSrcset(item);
            img.src = imageSrc(item, 1920);
        }

        function go(step) {
            if (list.length < 2) return;
            index = (index + step + list.length) % list.length;
            render();
        }

        function open(items, i) {
            if (!root) build();
            list = items;
            index = Math.max(0, i);
            isOpen = true;
            root.classList.add('open');
            document.body.classList.add('lb-lock');
            history.pushState({ lightbox: true }, '');
            render();
            root.querySelector('.lb-close').focus({ preventScroll: true });
        }

        function hide() {
            isOpen = false;
            root.classList.remove('open');
            document.body.classList.remove('lb-lock');
            mediaBox.innerHTML = '';
        }

        function close() {
            if (!isOpen) return;
            if (history.state && history.state.lightbox) history.back();
            else hide();
        }

        return { open: open };
    })();

    // ---- Booking form (Formspree + WhatsApp) --------------------------------

    function initBookingForm() {
        var form = document.getElementById('booking-form');
        if (!form) return;
        var required = form.querySelectorAll('[required]');

        form.querySelectorAll('input, select, textarea').forEach(function (input) {
            input.addEventListener('input', function () {
                if (input.hasAttribute('required')) input.classList.toggle('error', !valid(input));
            });
        });

        function valid(field) {
            if (field.type === 'checkbox') return field.checked;
            if (field.type === 'email') return /^\S+@\S+\.\S+$/.test(field.value.trim());
            return !!field.value.trim();
        }

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var firstBad = null;
            required.forEach(function (f) {
                var ok = valid(f);
                f.classList.toggle('error', !ok);
                if (!ok && !firstBad) firstBad = f;
            });
            if (firstBad) {
                alert(firstBad.id === 'terms'
                    ? 'You must accept the Terms and Conditions to proceed.'
                    : 'Please fill in all required fields.');
                firstBad.focus();
                return;
            }

            var el = form.elements;
            var msg =
                '*New Booking Request - Sons of Cauvery*\n\n' +
                '*Name:* ' + el.name.value + '\n' +
                '*Email:* ' + el.email.value + '\n' +
                '*Phone:* ' + el.phone.value + '\n' +
                '*Date:* ' + el.date.value + '\n' +
                '*Guests:* ' + el.guests.value + '\n' +
                '*Experience:* ' + (el.experience.value || 'Not specified') + '\n' +
                '*Message:* ' + (el.message.value || 'No special requests') + '\n\n' +
                '*Terms and Conditions:* Accepted';

            // Send the email copy in the background; keepalive lets it finish even if WhatsApp takes over the tab.
            fetch(form.action, {
                method: 'POST',
                body: new FormData(form),
                headers: { 'Accept': 'application/json' },
                keepalive: true
            }).catch(function () { /* WhatsApp message still goes through */ });

            document.getElementById('form-success').style.display = 'block';
            form.style.display = 'none';
            // Opened straight from the click so pop-up blockers allow it.
            var win = window.open('https://wa.me/916360250855?text=' + encodeURIComponent(msg), '_blank');
            if (!win) location.href = 'https://wa.me/916360250855?text=' + encodeURIComponent(msg);
        });
    }

    // ---- Misc -----------------------------------------------------------------

    function initMisc() {
        document.querySelectorAll('[data-year]').forEach(function (el) { el.textContent = new Date().getFullYear(); });
        // Light protection: no right-click "Save image" on gallery photos.
        document.addEventListener('contextmenu', function (e) {
            if (e.target.closest('.gallery-item, .lightbox, .hero-slideshow')) e.preventDefault();
        });
        document.addEventListener('dragstart', function (e) {
            if (e.target.tagName === 'IMG') e.preventDefault();
        });

        var slider = document.querySelector('.testimonial-slider');
        if (slider && slider.children.length > 1) {
            setInterval(function () {
                if (slider.matches(':hover')) return;
                var step = slider.children[0].offsetWidth + 30;
                var atEnd = slider.scrollLeft + slider.clientWidth >= slider.scrollWidth - 5;
                slider.scrollTo({ left: atEnd ? 0 : slider.scrollLeft + step, behavior: 'smooth' });
            }, 6000);
        }
    }

    function start() {
        initNav();
        initMisc();
        initBookingForm();
        dataPromise.then(function (data) {
            initBanner(data);
            initGalleries(data);
        }).catch(function () {
            document.querySelectorAll('[data-gallery]').forEach(function (g) {
                g.innerHTML = '<p class="gallery-empty">The gallery could not be loaded. Please refresh the page.</p>';
            });
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
