# SHAMROCK mark

The editable SVG is the canonical mark. It contains one flat green path and a transparent background, with no monogram or registration symbol. The silhouette was vectorized from the Notre Dame shamrock reference supplied for this design; it is not an official university vector download.

Reference: https://onmessage.nd.edu/athletics-branding/logos/shamrock/

The PNG is a transparent raster rendering of that SVG for Google Sheets, whose IMAGE function needs a raster image. It is not the reference bitmap. To regenerate it with librsvg:

```sh
rsvg-convert -h 512 -o assets/brand/shamrock.png assets/brand/shamrock.svg
```

Keep its aspect ratio and transparent background wherever it is used. Use the SVG directly in the web interface.
