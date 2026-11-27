# Screenshot assets

- Full-size screenshots live in this directory.
- Lightweight WebP previews live in `previews/` and use the same filename stem.
- The product demo keeps animation in `previews/task-detail-animated.gif`.
- README and landing cards load previews; links and the landing lightbox load full-size files.
- `12.png` and its preview are legacy aliases of `team-chat.png`; the preview script keeps them in sync.
- The documentation site's `product-preview.png` is copied from `1.png` by the same script.
- Run `pnpm screenshots:previews` after replacing a full-size screenshot. ImageMagick and FFmpeg are required.
