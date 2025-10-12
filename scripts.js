document.addEventListener('DOMContentLoaded', function() {
    // Mobile menu toggle
    const menuToggle = document.querySelector('.menu-toggle');
    const navMenu = document.querySelector('.nav-menu');

    if (menuToggle) {
        menuToggle.addEventListener('click', function() {
            navMenu.classList.toggle('active');
            menuToggle.classList.toggle('active');
        });
    }

    // Close mobile menu when clicking on a link
    const navLinks = document.querySelectorAll('.nav-menu a');
    navLinks.forEach(link => {
        link.addEventListener('click', function() {
            navMenu.classList.remove('active');
            menuToggle.classList.remove('active');
        });
    });

    // Gallery filtering
    const filterButtons = document.querySelectorAll('.tab-btn');
    const galleryItems = document.querySelectorAll('.gallery-item');

    if (filterButtons.length > 0) {
        filterButtons.forEach(button => {
            button.addEventListener('click', function() {
                // Remove active class from all buttons
                filterButtons.forEach(btn => btn.classList.remove('active'));
                
                // Add active class to clicked button
                this.classList.add('active');
                
                const filterValue = this.getAttribute('data-filter');
                
                // Show/hide gallery items based on filter
                galleryItems.forEach(item => {
                    if (filterValue === 'all' || item.classList.contains(filterValue)) {
                        item.style.display = 'block';
                    } else {
                        item.style.display = 'none';
                    }
                });
            });
        });
    }

    // Lightbox initialization (if using lightbox2 library)
    if (typeof lightbox !== 'undefined') {
        lightbox.option({
            'resizeDuration': 200,
            'wrapAround': true,
            'albumLabel': 'Image %1 of %2'
        });
    }

    // Video play functionality
    const videoContainers = document.querySelectorAll('.video-container');
    videoContainers.forEach(container => {
        const video = container.querySelector('video');
        const overlay = container.querySelector('.video-overlay');
        
        if (overlay && video) {
            overlay.addEventListener('click', function() {
                video.play();
                overlay.style.opacity = '0';
            });
            
            video.addEventListener('pause', function() {
                overlay.style.opacity = '1';
            });
            
            video.addEventListener('ended', function() {
                overlay.style.opacity = '1';
            });
        }
    });

    // Form handling for contact form with Formspree
    const bookingForm = document.getElementById('booking-form');
    if (bookingForm) {
        // This will be handled by Formspree directly, but we'll add some validation
        bookingForm.addEventListener('submit', function(e) {
            let isValid = true;
            const requiredFields = bookingForm.querySelectorAll('[required]');
            
            requiredFields.forEach(field => {
                if (!field.value.trim()) {
                    isValid = false;
                    field.classList.add('error');
                } else {
                    field.classList.remove('error');
                }
            });
            
            if (!isValid) {
                e.preventDefault(); // Prevent form submission if validation fails
                alert('Please fill in all required fields.');
            } else {
                // Form is valid, Formspree will handle the submission
                // We could add a loading state here if desired
                console.log('Form is being submitted to Formspree');
            }
        });

        // Handle form field validation on input
        const formInputs = bookingForm.querySelectorAll('input, select, textarea');
        formInputs.forEach(input => {
            input.addEventListener('input', function() {
                if (this.hasAttribute('required') && !this.value.trim()) {
                    this.classList.add('error');
                } else {
                    this.classList.remove('error');
                }
            });
        });
    }

    // Smooth scrolling for internal links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            const targetId = this.getAttribute('href');
            
            if (targetId !== '#') {
                e.preventDefault();
                const targetElement = document.querySelector(targetId);
                
                if (targetElement) {
                    window.scrollTo({
                        top: targetElement.offsetTop - 80, // Adjust for header height
                        behavior: 'smooth'
                    });
                }
            }
        });
    });

    // Testimonial slider autoplay
    const testimonialSlider = document.querySelector('.testimonial-slider');
    if (testimonialSlider && testimonialSlider.children.length > 3) {
        let scrollAmount = 0;
        const slideWidth = testimonialSlider.children[0].offsetWidth + 30; // Width + gap
        const maxScroll = testimonialSlider.scrollWidth - testimonialSlider.clientWidth;
        
        setInterval(() => {
            scrollAmount += slideWidth;
            if (scrollAmount >= maxScroll) {
                scrollAmount = 0;
                testimonialSlider.scrollTo({
                    left: 0,
                    behavior: 'auto'
                });
            } else {
                testimonialSlider.scrollTo({
                    left: scrollAmount,
                    behavior: 'smooth'
                });
            }
        }, 5000); // Change testimonial every 5 seconds
    }

    // Simple and reliable slideshow functionality
    function startSlideshow() {
        // Hero slideshow
        const heroSlideshow = document.querySelector('.hero-slideshow');
        if (heroSlideshow) {
            const heroSlides = heroSlideshow.querySelectorAll('.hero-slide');
            if (heroSlides.length > 1) {
                let heroCurrent = 0;
                
                setInterval(() => {
                    heroSlides.forEach(slide => slide.classList.remove('active'));
                    heroCurrent = (heroCurrent + 1) % heroSlides.length;
                    heroSlides[heroCurrent].classList.add('active');
                }, 4000);
            }
        }
        
        // Banner slideshow
        const bannerSlideshow = document.querySelector('.banner-slideshow');
        if (bannerSlideshow) {
            const bannerSlides = bannerSlideshow.querySelectorAll('.banner-slide');
            if (bannerSlides.length > 1) {
                let bannerCurrent = 0;
                
                setInterval(() => {
                    bannerSlides.forEach(slide => slide.classList.remove('active'));
                    bannerCurrent = (bannerCurrent + 1) % bannerSlides.length;
                    bannerSlides[bannerCurrent].classList.add('active');
                }, 4000);
            }
        }
    }
    
    // Start slideshow immediately
    startSlideshow();

    // Advanced Image protection functionality
    function protectImages() {
        // Disable right-click context menu globally
        document.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            return false;
        });

        // Disable drag and drop globally
        document.addEventListener('dragstart', function(e) {
            e.preventDefault();
            return false;
        });

        // Disable all keyboard shortcuts
        document.addEventListener('keydown', function(e) {
            // Disable F12, Ctrl+Shift+I, Ctrl+U, Ctrl+S, Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+P
            if (e.keyCode === 123 || // F12
                (e.ctrlKey && e.shiftKey && e.keyCode === 73) || // Ctrl+Shift+I
                (e.ctrlKey && e.keyCode === 85) || // Ctrl+U
                (e.ctrlKey && e.keyCode === 83) || // Ctrl+S
                (e.ctrlKey && e.keyCode === 65) || // Ctrl+A
                (e.ctrlKey && e.keyCode === 67) || // Ctrl+C
                (e.ctrlKey && e.keyCode === 86) || // Ctrl+V
                (e.ctrlKey && e.keyCode === 88) || // Ctrl+X
                (e.ctrlKey && e.keyCode === 80)) { // Ctrl+P
                e.preventDefault();
                return false;
            }
        });

        // Disable text selection globally
        document.addEventListener('selectstart', function(e) {
            e.preventDefault();
            return false;
        });

        // Disable print screen
        document.addEventListener('keyup', function(e) {
            if (e.keyCode === 44) { // Print Screen key
                e.preventDefault();
                return false;
            }
        });

        // Convert images to canvas to prevent direct saving
        function convertImagesToCanvas() {
            const galleryImages = document.querySelectorAll('.gallery-item img');
            galleryImages.forEach((img, index) => {
                // Create canvas
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                // Set canvas size to match image
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                
                // Draw image to canvas
                ctx.drawImage(img, 0, 0);
                
                // Add watermark to canvas
                ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.font = 'bold 20px Arial';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'bottom';
                ctx.fillText('Sons of Cauvery', canvas.width - 10, canvas.height - 10);
                
                // Add diagonal watermark
                ctx.save();
                ctx.translate(canvas.width / 2, canvas.height / 2);
                ctx.rotate(-Math.PI / 6);
                ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
                ctx.font = 'bold 40px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('Sons of Cauvery', 0, 0);
                ctx.restore();
                
                // Replace image with canvas
                canvas.style.width = '100%';
                canvas.style.height = 'auto';
                canvas.style.display = 'block';
                canvas.classList.add('protected-image');
                
                // Hide original image and show canvas
                img.style.display = 'none';
                img.parentNode.insertBefore(canvas, img);
            });
        }

        // Wait for images to load then convert
        window.addEventListener('load', function() {
            setTimeout(convertImagesToCanvas, 1000);
        });

        // Disable developer tools detection
        let devtools = {open: false, orientation: null};
        setInterval(function() {
            if (window.outerHeight - window.innerHeight > 200 || window.outerWidth - window.innerWidth > 200) {
                if (!devtools.open) {
                    devtools.open = true;
                    document.body.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100vh;font-size:24px;color:red;">Developer tools detected. Please close them to continue.</div>';
                }
            }
        }, 500);

        // Disable image saving through various methods
        document.addEventListener('DOMContentLoaded', function() {
            // Override common image saving methods
            const originalCreateElement = document.createElement;
            document.createElement = function(tagName) {
                const element = originalCreateElement.call(this, tagName);
                if (tagName.toLowerCase() === 'img') {
                    element.addEventListener('load', function() {
                        this.style.pointerEvents = 'none';
                        this.style.userSelect = 'none';
                        this.style.webkitUserSelect = 'none';
                        this.style.mozUserSelect = 'none';
                        this.style.msUserSelect = 'none';
                    });
                }
                return element;
            };
        });

        // Console warning and obfuscation
        console.clear();
        console.log('%c⚠️ WARNING ⚠️', 'color: red; font-size: 30px; font-weight: bold;');
        console.log('%cThis is a browser feature intended for developers only. Unauthorized access to images is prohibited.', 'color: red; font-size: 16px;');
        console.log('%cAll images are protected by copyright. Do not attempt to download or copy them.', 'color: red; font-size: 14px;');
        
        // Disable console methods
        console.log = function() {};
        console.warn = function() {};
        console.error = function() {};
        console.info = function() {};
    }

    // Initialize advanced image protection
    protectImages();
}); 