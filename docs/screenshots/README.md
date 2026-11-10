# Screenshot assets

- Full-size screenshots live in this directory.
- Lightweight WebP previews live in `previews/` and use the same filename stem.
- The product demo keeps animation in `previews/task-detail-animated.gif`.
- README and landing cards load previews; links and the landing lightbox load full-size files.
- Run `pnpm screenshots:previews` after replacing a full-size screenshot. ImageMagick and FFmpeg are required.
