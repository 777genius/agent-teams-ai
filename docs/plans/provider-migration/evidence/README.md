# Evidence: public index и локальные captures

Компактные `*-handoff.json`, `manifest.json`, `README.md` и `FINAL.md` остаются
reviewable metadata: original status, scope, source/artifact hashes и ограничения.
Наличие этих файлов не расширяет прежний acceptance и не превращает INCOMPLETE в PASS.

Untracked raw capture directories, retained source/bundles/state и новые tar-архивы
исключены из будущего PR через `.gitignore`. Все существующие локальные bytes
сохранены; ignore не удаляет их и не изменяет уже tracked artifacts.

Ссылка из основного плана ведёт на public handoff, если он сохраняет exact archive
identity. При отсутствии такого соответствия имя архива отмечено как локальный
файл. Это не обещание доступности raw bytes на GitHub и не размер intended PR.
