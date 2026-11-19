# P09: решение о записи в выбранный источник и потреблении его байтов

**19 ноября 2026 владелец явно выбрал A в текущем чате.** Ниже зафиксирована
разрешённая граница; source-срез реализован и независимо проверен. Native A на
Linux x64 и Darwin x64 прошёл; Darwin ARM ещё ожидает своего исходного job. Исторические
INCOMPLETE и контрпримеры прежней гарантии сохраняют свои исходные результаты.

## Принятое A: конкретная граница

Для каждого выбранного native executable/script доверие относится к исходным
captured `path` и `sha256`, а не к имени провайдера или произвольному будущему пути.
Все субъекты, способные писать в выбранный inode или подменить его путь в течение
использования, считаются доверенными и обязуются сохранять выбранную ревизию от
проверки до подтверждённой очистки всех исходных owned scopes, потребляющих эту
ревизию. Seal, потеря currentness, exit root или закрытие одной из параллельных
scopes не освобождают остальные от этого условия. Это включает
тот же UID, updater, уже открытые writable FD и writable mmap. Доверенным считается
весь такой набор; отдельное исключение иных writers этой реализацией не заявляется.
Если будущая композиция заявит исключение writer, ей потребуется реальное
доказательство исключения, отдельно от данного доверительного договора.

Исходный путь, argv0/$0, argv/env/cwd, scripts и относительные ресурсы сохраняются.
Изменение используемой ревизии, self-modifying scripts и hot update того же файла
до завершения consumption выходят за принятый договор. Новую версию можно готовить
по отдельному пути; подмена используемого источника не становится безопасной из-за
названия updater, chmod, группы или позднего повторного hash.

Текущие проверки captured source/currentness и отказ при обнаруженном изменении
сохраняются. Они обнаруживают несоответствие в точках проверки и не обещают
исключения записи после последней проверки. Договор не меняет process authority,
birth/owner/custody, Stop/drain/release, deadlines, provider pins или Stage 1 scope.
Team-data/WorkSync `LegacySourceWriteAdmissionPolicy` не является admission для
исполняемых файлов и не переиспользуется для этой задачи.

Приёмка A должна отдельно доказать обычный product launch исходного native файла
и script, неизменность пути/аргументов/окружения/ресурсов, отказ до запуска при
известном изменении source и полную очистку. Прежние mutation schedules продолжают
собирать факты и строгий прежний verdict, явно вне A, без переименования отказов в
PASS. Ошибки самого collector, original child/birth/group/custody identity и cleanup
остаются отказами приёмки. Недоступность прежнего SecCode/kernel-image proof
остаётся его отдельным INCOMPLETE и не превращается в требование signing для A.

## Ограниченный срез реализации и приёмки

База: `33ea959ad1b2496ab393e04fa50e610e092224ec`. Один владелец каждого файла;
root объединяет source, evidence и этот план. Исправления других E2E независимы.

| Часть | Изменение | Оценка |
| --- | --- | --- |
| `CapturedProcess.ts`, `RuntimeSourceNativeVersion.ts` | Явный приватный construction contract A на уже скопированных path/digest и существующей custody lifetime; пояснить предел hash-наблюдения. Runtime behavior, schema, flags, ports и persisted references не меняются. | 24–30 строк комментариев |
| `registered-process-executable.native.ts` | В той же исходной lane выполнить production `CapturedProcess` для compiler-default native файла и script; проверить путь/$0, literal argv, env/cwd, sibling resource, caller-profile isolation, prelaunch changed-source/currentness refusals и original cleanup. Отдельно сохранить все прежние strict assertions и per-case outcomes в legacy cohort. | 190–230 строк TS |
| `fixtures/posix-exec-native.c` | Один bounded Darwin script-контрпример с заранее открытым writable mmap; отражает нарушение A, не доказательство исключения writer. Существующие Linux/Darwin rename/in-place/after-check/open-FD schedules сохраняются. | 35–50 строк C |
| `opencode-v2-stage1-preflight.yml` | Явно назвать принятый contract в существующей POSIX step; сохранить исходный runner, запуск, artifact и budgets. | 2–5 строк |

Оценка исполняемого среза: 225–280 строк, сложность **5/10**, ожидаемая надёжность
**8/10**, уверенность до native-проверок **7/10**. Это оценка плана, не результат
проверки на macOS. Новый process controller, policy token, schema migration, writer
scanner, permission repair, copy execution, новый job или матрица не нужны.

Первый раунд критики отделил Team-data writer admission от native source trust и
отклонил новый policy flag как не обеспечивающий дополнительных гарантий. Второй
раунд root/двух независимых reviewers уточнил общую lifetime всех consuming scopes,
сохранил compiler-default без нового signing требования и разделил old image proof
от original custody/cleanup. Эти замечания включены до изменения source.

Новый receipt явно именует A и его product-path outcomes. Legacy strict verdicts
остаются PASS/COUNTEREXAMPLE/INCOMPLETE с фактическими наблюдениями; общий успех A
не переклассифицирует их. Compile/source pin/collector/child identity/cleanup
ошибки остаются fatal. Исторический отказ7fe/33ea остаётся историческим отказом.
Все исходные100s observation,120s outer test и cleanup deadlines сохраняются.

Независимый R2 exact diff завершён. TS7 Host build, все Host test types, строгая
C-компиляция controller/library/payload и source-size guard прошли. Native lane
исполняется на frozen source для Linux и двух Darwin architectures. Нативные Claude/Codex не запускаются. Используются только
исходные TEST actors; vendor/provider pins и остальные обязательные E2E неизменны.
PASS A не заменяет readiness, Desktop, packaged или остальную Stage1-приёмку.

В source review исправлены четыре конкретных замечания. Исключение старого
image proof сужено до наблюдавшегося Darwin compiler-default baseline:
`kernel-image-validity`, `EACCES`, `codeSigningError=-67062`. Иные неожиданные
baseline failures остаются fatal. Ошибка реально предпринятой mutation, кроме
исходных `0`/`ETXTBSY`, остаётся ошибкой collector. Writable mmap FD перед mapping
проверяется по regular-file, dev/ino/size исходного captured object и bound2MiB;
его unmap входит в cleanup. Прежний45-line strict assertion block побайтно
сохранён. [Evidence source review](evidence/p09-contract-a-review-20261119.json)
содержит preimages, итоговые hashes, проверки и границы полученного результата.

Первая original Linux-попытка на опубликованном чистом `f6c223c9` завершила plain
control, но PTRACE_TRACEME вернул EPERM до исходного stop/birth observation.
Receipt сохраняет INCOMPLETE, original child/group cleanup=true и отсутствие
исполненных product rows. [Полный receipt и журнал](evidence/p09-contract-a-local-linux-20261119.json)
не выдаются за A PASS; дальнейшая проверка проходит в существующей CI lane.

Исходный [Darwin x64 job135773065012](https://github.com/777genius/agent-teams-ai/actions/runs/44584326495/job/135773065012)
на `fbc77ea6b9a35f4be640d7b1e103b992a3f3a45e` полностью завершился SUCCESS,
включая native V2 journey и P09 step25. A receipt:
`PASS_TRUSTED_WRITER_FIXTURE_ONLY`, все8 CapturedProcess observations PASS,
cleanup=true. Старый strict cohort остаётся INCOMPLETE: compiler-default baseline
EACCES/-67062, after-check и writer-open INCOMPLETE; оба script mutation schedules
сохраняют COUNTEREXAMPLE с SCRIPT:B. Все11 strict cleanups подтверждены.
`installedRuntimeQualified=false`, `releaseQualified=false`. Artifact14561975640:
12099bytes, SHA-256 `fd97a3d781e46b8b8608bb210509675a387f19089c82570fd5afad608dd0550c`.
Это отдельный результат Darwin x64, который не квалифицирует другие платформы
или оставшиеся Desktop paths.

Исходный [Linux x64 job135773064871](https://github.com/777genius/agent-teams-ai/actions/runs/44584326495/job/135773064871)
на том же fbc также полностью SUCCESS, включая P09 step25. Все8 A observations
PASS, cleanup=true, installed/release=false. Linux legacy strict сохраняет
`PASS_NATIVE_FIXTURE_ONLY`, script-negative — COUNTEREXAMPLE с SCRIPT:B,
scriptQualified/productQualified=false. Artifact14563098271:24851bytes,
SHA-256 `aa9398579e16ad42825674d6cecc1842f17d7f9cfb9a27508b4d235b029146a1`.
Darwin ARM ещё queued; его исходный результат остаётся обязательным.

Отдельный read-only review встроенных writers подтвердил существующую совместимость
с A: OpenCode V1 сохраняет проверенные существующие bytes и отказывает перед
перезаписью несовпадающего destination; V2 CLI/support и Codex устанавливают новую
UUID/version directory и меняют указатель, сохраняя прежнюю directory. Captured
installers публикуют новую source revision. Обычный Claude installer при выбранном
Host отказывает до установки. Existing installer tests проверяют разные A/B paths,
сохранение старых bytes/inode и rollback; эти тесты здесь повторно не запускались.
Новая lifetime registry или дополнительный updater owner поэтому не вводятся.

## Почему прежняя гарантия не была доказана

Контракт одновременно сохраняет исходный pathname, argv0/$0, argv/env/cwd, ресурсы относительно executable и произвольные существующие scripts, но учитывает недоверенный процесс с правом заменить pathname или изменить тот же inode. Повторный hash не запрещает запись после последней проверки. В исходном Darwin script-контроле остановленному ребёнку уже выбран interpreter; после успешной перезаписи script interpreter читает исходный pathname и исполняет **SCRIPT:B**. Проверка образа interpreter этого разрыва не закрывает. Для Mach-O продолжение с A-маркерами после записи также не доказывает привязку всех выбранных байтов; исходный oracle остаётся непройденным. [1]

Среди уже рассмотренных механизмов полной реализации этого сочетания не найдено. Это не утверждение о невозможности любого OS-дизайна. `flock` не запрещает запись процессу, игнорирующему advisory lock; Darwin `F_SETLEASE` существует, но рассмотренная реализация требует private entitlement и допускает разрыв lease; SecCode не заменяет доказательство исходных байтов при нынешней поддержке unsigned/custom источников. [2]

## Рассмотренные направления: выбран A

| Решение | Что именно разрешается изменить | Семантика и совместимость |
| --- | --- | --- |
| **A. Исходный путь, явно ограниченный набор writers** | Разрешить для конкретного выбранного источника явный договор доверия: все субъекты, сохраняющие право write/rename, включая владельцев уже открытых writable FD/mmap, обязуются не менять выбранную ревизию от проверки до завершения её потребления в исходной owned process scope. Для остальных требуется реально установленное исключение записи/подмены файла и его пути. Название updater, общий UID/GID или поздний chmod сами по себе такого разделения не доказывают. | Байты по-прежнему читаются из исходного файла; pathname/$0, аргументы, cwd и поиск ресурсов сохраняются. Перезапись того же источника во время использования, self-modifying scripts и hot update требуют отсрочки либо отдельного согласованного правила. Публикация B по отдельному пути может сосуществовать с A, если A остаётся неизменным. Это **явное сужение прежней защиты от writer**, а не исправление той же гонки. |
| **B. Зафиксированная версия становится источником исполнения** | Разрешить запуск отдельной проверенной версии executable/script и удержание её байтов стабильными в отношении прежнего writer на весь период потребления. Writer может продолжать менять исходный файл; запуск должен больше не зависеть от его последующих чтений. Требуются отдельно одобренные хранение/доступ и доказательство связи captured digest → реально потреблённые bytes; простой FD, имя «immutable» или read-only bit этого не дают. | Разрешается изменить launch provenance и фактический путь потребления. Native argv0 можно передать отдельно, но это не сохраняет все наблюдения пути. У scripts меняются `$0`, self-read/`dirname "$0"`, поведение записи в себя и executable-relative resources. Копирование одного файла не обеспечивает прежнюю произвольную совместимость; для требуемых исключений нужен явно ограниченный адаптер/набор ресурсов либо отдельный механизм представления исходного пути. Это более широкий дизайн, не прозрачный fallback. |

Решение владельца разрешает перечисленное изменение A. B не выбран. Решение не
разрешает молча отклонять scripts, менять пользовательские permissions, копировать
источник или засчитывать прежний отрицательный тест как PASS. Существующие
результаты сохраняются; конкретный срез proof/acceptance проходит ревью до source. [1]

## Основание выбора и пределы

Владелец принял доверие описанным субъектам с правом записи и ограничение изменения
используемой ревизии. A сохраняет frontend-совместимость и не требует нового слоя
исполнения. Доверие привязано к конкретному источнику и полномочиям записи; нельзя
считать отдельно доверенным updater, если другие процессы обладают теми же правами.

Защита от недоверенного процесса, сохраняющего право записи, не является гарантией A.
Если она станет обязательной, потребуется новое решение о B или ином механизме;
обещать её как свойство данного среза нельзя.

Выбор направления **не квалифицирует** actual native peer, Darwin x64/ARM64, другие OS/filesystems, packaged приложение или release. Для последующего bounded proposal нужны точные preimages, публичная authority, исходный process object/custody/cleanup и исходные rename/in-place/already-open/after-check schedules в существующей native lane и её бюджетах. [1]

### Основание

[1] [P09, §§75.2–75.9, исходный опубликованный контракт и receipts](https://github.com/777genius/agent-teams-ai/blob/852d9bd3f9142603340f71ca998739e69da00084/docs/plans/provider-migration/frontend-parity-2026-11-12/09-cross-platform-processes.md).

[2] Публичные первичные источники, проверенные отдельно от native qualification: Apple XNU commit `f6217f891ac0bb64f3d375211650a4c1ff8ca1ea`, [F_SETLEASE в fcntl.h](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/fcntl.h) и [entitlement/forced lease break в vfs_subr.c](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_subr.c); [Apple flock(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html); [Apple TN3126, per-page signature checking](https://developer.apple.com/documentation/technotes/tn3126-inside-code-signing-hashes). Это source/documentation review; native выполнение для этой записки не проводилось.
