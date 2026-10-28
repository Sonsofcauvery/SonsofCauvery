# Sons of Cauvery - Fishing Camp Website

Live site: https://sonsofcauvery.github.io/SonsofCauvery/
Gallery admin: https://sonsofcauvery.github.io/SonsofCauvery/admin.html

## Managing photos and videos (no code, no git)

Open **admin.html** on a phone or computer and enter the passcode. From there you can:

- **Add photos / videos**: pick one or many files. Photos are resized and compressed automatically.
- **Reorder**: drag a picture to a new spot (on a phone, press and hold it for a moment first), or tap **1st** to move it straight to the top.
- **Banner slideshow**: tap the star on a photo to add it to the banner at the top of every page, and drag the banner thumbnails to change their order.
- **Edit titles**, **hide** items without deleting them (eye button), or **delete** them (bin button).
- **Add YouTube video**: paste a link. Use this for long videos.
- Press **Publish changes**. The website updates in about 1 minute.

Photos and videos of any size can be added: photos are shrunk to web sizes, and videos are compressed in the browser to 720p MP4 (a 500 MB camera video usually ends up around 20-45 MB). Keep the page open while a video compresses. Videos longer than about 6 minutes should go on YouTube (use **Add YouTube video**). RAW camera files (.CR2, .NEF, .ARW, .DNG...) can't be opened by browsers: export them as JPG first.

The first 8 gallery items also show in the "From Our Gallery" section on the home page.

## Editing text, pictures and contact details

In admin.html, the **Edit pages** tab shows each page exactly as visitors see it:

- Click any text with a yellow dotted outline and type. Footer changes apply to every page.
- Click the home page photo to replace it.
- Testimonials, "What We Offer" cards and terms/cancellation sections have **+ Copy** and **Remove** buttons.
- "Page title & Google description" sets what shows in the browser tab, on Google and in WhatsApp link previews.

The **Contact details** tab changes the phone number, WhatsApp number, email, Instagram and YouTube links everywhere at once (including the booking form and WhatsApp button).

Press **Publish changes** and the site updates in about a minute. Editable spots are marked in the HTML with `data-edit`, `data-edit-img`, `data-edit-list` and `data-edit-item` attributes; new text added to the pages needs one of these to be editable from the admin page.

## Version history and going back

Every publish is saved. The **History** tab lists each one with its date, who published it and what changed (type a short note in the box next to **Publish changes** if you like; otherwise a summary is written automatically). Enter your name once in the History tab so each publish shows who made it.

Press **Restore** on any version to put the gallery, photos/videos, page text and contact details back the way they were then. The restore is saved as a new version on top, so you can always undo it by restoring the version above it. The site's code and the admin key are not changed by a restore. Versions from before page editing was added only restore the photos and videos.

## One-time admin setup

1. Push this folder to the `main` branch of `Sonsofcauvery/SonsofCauvery` (GitHub Pages keeps serving the same URL).
2. Create a GitHub fine-grained token at https://github.com/settings/personal-access-tokens/new
   - Repository access: **Only select repositories**, then pick `SonsofCauvery`
   - Permissions, Repository permissions: **Contents: Read and write**
   - Expiration: the longest option available
3. Open `admin.html` on the live site, paste the token, choose a passcode and save.
4. Share only the **passcode** with whoever should manage the gallery.

When the token expires, open admin.html, unlock, go to **Settings** and paste a new one. You can change the passcode there too.

### How it's protected

The token is saved in `data/admin-config.json`, encrypted with the passcode (PBKDF2 with 600,000 rounds, then AES-256-GCM). Visitors without the passcode can't change anything. Because the encrypted file is public, use a long passcode (a short sentence works well). The token can only change this one repository, and every change is a git commit, so any mistake can be undone from the GitHub history.

## Files

```
index.html, gallery.html, contact.html, terms.html, cancellation-policy.html, 404.html
admin.html, admin.js      Gallery admin page
scripts.js                Site behaviour: banner, gallery, viewer, booking form
styles.css                All styles (colours are at the top in :root)
icons.svg                 Icons (Font Awesome Free, CC BY 4.0)
data/gallery.json         Gallery order, titles and banner list (edited by admin.html)
media/                    Compressed photos (WebP, 480/960/1920 px wide) and videos
vendor/Sortable.min.js    Drag-and-drop library used by the admin page
vendor/mediabunny.min.mjs In-browser video compression for the admin page (MPL-2.0)
```

Each photo is stored in three sizes so phones download small versions and big screens get sharp ones. Photos load only as you scroll to them.
