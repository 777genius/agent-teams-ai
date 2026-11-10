# Папки задач и прилегающая панель дерева

Дата: 2026-10-11. Статус: план после двух раундов review и исправлений;
реализация не начата.

## Цель

Дать пользователю собственную вложенную структуру папок для задач. При начале
перетаскивания из правого Tasks sidebar открывать панель вплотную слева от него.
После окончания drag сохранять панель на 2000 мс; наведение, фокус и управление
папками удерживают её открытой. Архивные задачи сохраняют папку и отображаются
в ней приглушёнными, но доступными для открытия и восстановления.

## Текущее устройство и доказательства

- `src/renderer/components/layout/Sidebar.tsx`: правый sidebar, ширина 200–500 px,
  default 280 px; контейнер `overflow-hidden`, поэтому дерево требует portal.
- `src/renderer/components/sidebar/GlobalTaskList.tsx`: группировки `none`,
  `project`, `time`; сначала фильтрация архива, затем группировка. Сейчас Archive
  переключает между активными и только архивными задачами.
- `src/renderer/utils/taskGrouping.ts`: проектные группы вычисляются из
  `projectPath`. Они не являются пользовательскими папками.
- `src/renderer/hooks/useTaskLocalState.ts`: pin/archive/rename хранятся в
  localStorage (`taskPinnedIds`, `taskPinnedProjectKeys`, `taskArchivedIds`,
  `taskRenamedSubjects`), ключ задачи `teamName:taskId`; каждый hook имеет свой state.
- `src/shared/types/team.ts`: `GlobalTask` содержит `teamName`, `id`, `projectPath`,
  `teamDeleted`; это исходная задача, её не нужно копировать в хранилище папок.
- `package.json`: React 19, уже есть dnd-kit и `@tanstack/react-virtual`.
- `scripts/ci/source-file-size-baseline.json`: GlobalTaskList уже oversized и
  заморожен; интеграция не должна увеличивать его относительно действующего cap.
- В worktree есть чужие изменения, в том числе SidebarTaskItem. Не откатывать их.

## Scope и границы

### Включено

1. Панель дерева, автоматическое открытие по task drag и кнопка «Папки».
2. Создание, вложение, переименование, удаление папок; перемещение и порядок
   папок/задач; раздел «Без папки» для задач без размещения.
3. Headless Tree для структуры, клавиатуры и DnD; shared Radix primitives для
   кнопок с tooltip, context menu, dialog и подтверждения удаления папки.
4. Архивные задачи внутри исходной папки, локальное долговечное размещение,
   синхронное отображение изменений в дереве и текущем списке.
5. Проверки потери размещения, гонок сохранения, таймеров и Electron DnD.

### Исключено

- Реализация в рамках этой задачи: deliverable сейчас только план и два review.
- Изменение agent tasks, projectPath, команды, статуса, сообщений или runtime.
- Перенос реальных файлов/проектов, серверная синхронизация папок, новая IPC/HTTP API.
- Переписывание DnD kanban или всего legacy sidebar, multi-select/bulk move.
- Группировка sidebar по пользовательским папкам: дерево является отдельным
  местом организации; существующие project/time/none остаются доступны.

### Зависимость

Рекомендованная библиотека: `@headless-tree/core` + `@headless-tree/react`.
На 2026-10-11 `pnpm view` возвращает 1.7.0 для обоих пакетов, MIT; React peers
у react-пакета `*`. При реализации повторно проверить stable version и закрепить
одинаковые точные версии через pnpm. Peer range сам по себе не доказывает работу
с React 19: проверить небольшой Electron spike до остального UI.

Официальные источники:
- [Внешний DnD через DataTransfer](https://headless-tree.lukasbach.com/dnd/foreign-dnd/).
- [Правила перемещения и индексы](https://headless-tree.lukasbach.com/dnd/overview/).
- [Виртуализация через внешний virtualizer](https://headless-tree.lukasbach.com/recipe/virtualization/).
- [Обновления внешнего состояния](https://headless-tree.lukasbach.com/recipe/external-state-updates/).
- [Точный контракт foreign dragover/drop](https://headless-tree.lukasbach.com/api/core/interface/DragAndDropFeatureConfig/).

## Архитектура и владение данными (Q)

Новая фича `src/features/task-folders/`: `core/domain` (модель/инварианты),
`core/application` (команды и порт repository), `renderer` (UI, hooks,
view-models, Headless Tree/storage adapters). Это локальная browser-safe фича:
main/preload/contracts не добавлять без реальной межпроцессной ответственности.
Внешний код импортирует только `@features/task-folders/renderer`.

- Domain не импортирует React, Zustand, localStorage, Electron, Headless Tree.
- Headless Tree adapter переводит drag targets в наши команды; vendor node
  instances не входят в модель хранения или application.
- Repository порт: `load(): Promise<LoadResult>`,
  `save(snapshot): Promise<void>`; ошибки явные, не silent fallback.
- Конкретный browser repository хранит один JSON snapshot под новым ключом
  `taskFolders:v1`. Нормализация/schema отдельно от storage, UI storage не читает.
  Не переиспользовать GridLayoutRepository с его silent-error fallback для данных.
- Один store/controller фичи на renderer и одна последовательная очередь команд.
  Все потребители подписываются на него; повторный mount не создаёт новое хранилище.
- Legacy pin/archive/rename выделить в общий observable presentation store с
  прежними ключами localStorage и прежним API `useTaskLocalState`. Дерево читает
  этот же источник. Это узкая миграция ownership, не перенос всех legacy настроек.
- Task detail navigation, mark unread, archive/restore и rename использовать через
  callbacks существующего приложения. Tree UI получает данные/действия через hook.

### Snapshot v1

Иллюстративный контракт, имена можно уточнить без изменения семантики:

```ts
type TaskIdentity = { teamName: string; taskId: string };
type Child = { kind: 'folder'; id: string }
  | { kind: 'task'; identity: TaskIdentity };
type Folder = { id: string; name: string; children: Child[] };
type Snapshot = { version: 1; revision: number;
  rootFolderIds: string[]; folders: Folder[] };
```

Порядок задаётся массивами. Parent index и task placement map выводятся из
snapshot, не хранятся второй независимой копией. Задача без ссылки ни в одной
папке относится к виртуальному «Без папки». Folder IDs создаются через UUID.
Для node ID задач использовать JSON-кодирование пары identity с префиксом,
не неоднозначную конкатенацию. Legacy presentation key сохраняется только
в legacy adapter; не менять существующие archived/pinned значения.

Инварианты: folder существует ровно в одном parent/root; нет циклов, дубликатов
ID и ссылок; задача имеет максимум одну папку; task leaf не принимает children.
Имя trim, 1–120 символов; одинаковые имена допустимы, identity только по UUID.
Перемещение не изменяет содержимое GlobalTask и presentation state.

### Команды и сохранение

- `createFolder(parentId | null, name)`, `renameFolder(id, name)`;
  `moveFolder(id, parentId | null, anchor)`;
  `moveTask(identity, folderId | null, anchor = append)`;
  `deleteFolder(id)` с описанным ниже сохранением содержимого.
- Все команды валидируют актуальный snapshot. Индекс применяется после удаления
  источника, не до него. Vendor insertionIndex принадлежит projected children,
  поэтому не передавать его напрямую в canonical children, где могут быть скрытые
  архивные/недоступные ссылки. Adapter переводит target в стабильный anchor
  `beforeChild` (identity видимого следующего sibling) или `append`; application
  разрешает anchor в canonical массиве после удаления источника. Для первого
  слота перед первым видимым sibling; для последнего append после всех children.
  Скрытые children сохраняют взаимный порядок. Canonical `[A, unavailable, B]`:
  drop перед B → `[A, unavailable, moved, B]`, не вставка на projected index 1.
  Если anchor исчез до выполнения queued команды, отклонить её, не угадывать индекс.
  Внешний API move-команд принимает anchor; числовой индекс остаётся только
  внутренним вычисленным параметром domain операции. Drop на папку → append.
  Для same-parent move adapter исключает source из projected children и берёт
  следующий sibling по уже скорректированному vendor insertionIndex; повторно
  вычитать source index нельзя. Пример `[A,B,C]`, A после B: after-removal `[B,C]`,
  insertionIndex 1 → before C → `[B,A,C]`. Для foreign/sidebar task source тоже
  исключить из target projection, если уже размещён там; foreign index относится
  к исходным visible children, поэтому корректировать удаление источника один раз
  в нашем adapter (Headless Tree не знает, что внешний task уже имеет placement).
  Empty parent → append. No-op перенос не повышает revision и не вызывает save.
- Save-before-publish: команда готовит новый snapshot, сохраняет его одним
  `setItem`, затем публикует. Следующая команда вычисляется из committed snapshot.
  На storage error состояние остаётся прежним, показать ошибку с повтором команды.
- До завершения load редактирование/drag отключены, просмотр списка работает.
  Не сохранять пустой initial state поверх поздно загрузившегося snapshot.
- `load` различает empty, valid, corrupt, unsupported-version, unavailable.
  При corrupt/unsupported ничего не перезаписывать; read-only сообщение и явное
  действие «Сбросить организацию папок» с подтверждением. Задачи остаются в списке.
- Удаление папки не удаляет задачи: children поднимаются в родителя на её позицию;
  при удалении root-папки child folders становятся root, задачи → «Без папки».
  Перед удалением shared confirmation сообщает этот результат.
- Не удалять ссылки на задачи из-за неполного refresh/фильтра/пропавшей команды.
  Неразрешённые task refs сохраняются, не рендерятся как обычные задачи; в папке
  показывать отдельный счётчик «недоступно». Возвращение исходной задачи восстанавливает
  её размещение. Автоматический GC и восстановление удалённых agent tasks вне scope.

## UX и состояния панели

### Геометрия

Portal в renderer overlay root вне `overflow-hidden`. Панель немодальная,
не блокирует sidebar и не включает focus trap. Правая граница совпадает с левой
границей sidebar, top/bottom совпадают с ним; default width 300 px.
Ширина `min(300, sidebarRect.left)` ограничена доступным слева пространством;
длинные имена truncate с Radix Tooltip. При менее 200 px использовать компактные
строки и перенос toolbar, не перекрывать sidebar и не выходить за viewport.
Если слева вообще нет места, кнопка открывает альтернативный shared dialog chooser
для тех же folder CRUD/move команд; drag не делает невидимую панель drop target.
Размер/позиция обновляются по ResizeObserver/sidebar resize и viewport resize.

### Жизненный цикл

Хранить причины удержания, а не один `isHovered`: active task/folder drag,
pointer inside panel, focus inside panel, rename/create edit, portaled menu/dialog,
manual-open. Открытие кнопкой включает manual-open до повторной кнопки/close/Escape.

1. Валидный task dragstart → open + activeDrag; очистить старый hide timer.
2. Любое окончание drag (accepted/rejected/cancelled) → снять activeDrag;
   если нет hold reasons, поставить единственный таймер на 2000 мс.
3. Pointer enter/focusin/edit/menu/dialog → отменить timer; выход/закрытие
   последней причины → новый полный интервал 2000 мс.
4. Drop и последующий dragend завершают один session ID идемпотентно; не ставят
   два таймера. Новый drag инвалидирует callback старого таймера.
5. Escape сначала отменяет edit/menu или drag, не одновременно несколько уровней;
   затем закрывает manual panel. Принудительное закрытие не теряет сохранённые данные.
6. Blur окна завершает active drag, но не закрывает открытый edit/dialog.
   Unmount/collapse sidebar очищает listeners/timers и закрывает overlay.

Controller живёт на уровне host, независимо от mount отдельной task row. Capture
listeners document отслеживают drag/drop, Escape и blur являются fallback.
Виртуализатор сохраняет mounted текущую native drag source строку через range
extractor до конца сессии; overscan сам по себе недостаточен. Если источник удалён
refresh-ом, отменить сессию и vendor DnD state, сохранив hover/focus holds.
Завершение internal tree drag связано с тем же host controller, не только с
foreign-drop callback. Timer закрывает panel по фактическому истечению, не раньше
2000 мс; background throttling может только увеличить задержку.

После drag нельзя надёжно полагаться на mouseenter: курсор мог уже находиться над
деревом. На drop запомнить target containment; на dragend сверить последний
pointer position и panel rect. После окончания drag возобновить обычный pointer/focus
tracking. Portal меню/dialog сообщает hold через onOpenChange, не DOM contains.

### Дерево и архив

- Root содержит пользовательские папки и системный «Без папки» (не переименовывать,
  не удалять). Системный узел всегда последний, не входит в rootFolderIds, не
  draggable и не принимает folders. Root ordering применяется только к folders;
  task drop в root/на «Без папки» → unassign без ручного индекса. New folder в root
  и context menu «Новая подпапка». Reorder внутри «Без папки» выключен (freshness).
- Tree по умолчанию показывает активные и архивные задачи вместе в исходных папках;
  архивные строки серые, с archive icon/accessible label, остаются focusable и draggable.
  Опциональный переключатель «Показывать архивные» действует только на дерево,
  default true; при restore позиция сохраняется.
- Существующий Archive button списка сохраняет семантику active/archived-only.
  В дереве не применять archive filter из GlobalTaskList.
- Tree показывает весь каталог независимо от project/team/status/unread/search
  фильтров списка: пользователь всегда видит цели переноса. Фильтры списка не
  меняют ownership или сохранение папок. Отдельный поиск дерева вне первого scope.
- Порядок children ручной и не перестраивается после activity/update/архивации.
  Раздел «Без папки» использует существующую freshness сортировку.
- Pinned в списке остаётся shortcut: задача одновременно может быть pinned и
  находиться в одной папке. В дереве единственное размещение, без дубликата Pinned.
- Счётчик папки: доступные задачи во всём subtree, активные/архивные отдельно;
  недоступные refs отдельным числом. Пустые папки остаются видимыми.
- Keyboard: стрелки/expand/collapse от библиотеки, Enter открывает task detail,
  F2 переименовывает folder; «Переместить в…» в task menu открывает chooser папок
  и вызывает ту же moveTask. Drag handle отдельный от клика/редактирования текста.
  Empty/слишком длинное folder name оставляет editor открытым с inline error;
  Escape отменяет без save, IME Enter не подтверждает. После create открыть parent
  и фокусировать новый node; после удаления focus переходит на parent/ближайшего
  sibling. Если node скрыт переключением архива, focus переходит на его parent.
- Виртуализация видимых строк через имеющийся react-virtual; фиксированная компактная
  высота обычной строки, rename той же высоты. Сохранить библиотечный ref вместе с
  virtualizer ref и scroll-to-focused/drop-target; не писать своё рекурсивное дерево.
  `getItemKey` и React key = стабильный node ID, не flat index; pinned drag source
  index пересчитывать из ID при изменении projection, чтобы DOM не переиспользовался
  для другой задачи во время drag. [Virtualizer API](https://tanstack.com/virtual/latest/docs/api/virtualizer).

### Синхронизация vendor view

Выбрать `syncDataLoaderFeature`. View-model получает committed snapshot + текущий
каталог + archive flags/visibility. После новой projection version loader должен
видеть новые данные до rebuild. При React-held projection вызывать
`tree.scheduleRebuildTree()` для следующего render/getItems; не делать немедленный
`rebuildTree()` по старому closure. Create/delete/move, изменение каталога и
archive visibility обновляют projection. На failed save projection не меняется.
Expanded IDs сохранять для существующих папок; удалённые focus/selection IDs
заменять по правилу выше. Проверить немедленное обновление без collapse/expand.

## DnD контракт

Для Tasks/tree используется HTML DnD из Headless Tree, без второго dnd-kit sensor
на той же строке. Остальные поверхности приложения не меняются.

- MIME `application/x-agent-teams-task-v1`; payload только version + TaskIdentity.
  Same-renderer drag session ID хранить в controller, не доверять чужому payload.
- Sidebar handle onDragStart записывает DataTransfer и открывает panel.
  EffectAllowed/dropEffect = move. Превью содержит subject, не полный GlobalTask.
- `canDragForeignDragObjectOver` проверяет доступные MIME types, session и target;
  не читает JSON в protected dragover. `canDropForeignDragObject` на drop выполняет
  parse/schema validation, проверку identity по текущему каталогу и разрешённой
  target, возвращает только boolean и не меняет state/storage. Единственный
  `onDropForeignDragObject` повторно проверяет session/identity/target, переводит
  target в command anchor и вызывает moveTask один раз. Domain/application перед
  save заново проверяет актуальные данные; неверный drop возвращает явный отказ.
- Внешние файлы, URL, произвольный text и drags из других окон игнорировать.
  Root/«Без папки» принимает task и снимает размещение; task leaf не принимает drop.
- Internal onDrop переводит folder/task move в domain command. Не использовать
  vendor helper как самостоятельную запись children в обход инвариантов/сохранения.
- Hover на collapsed folder раскрывает её через 600 мс (library setting);
  использовать `openOnDropDelay`; уход отменяет pending expansion.
- `scrollToItem` переводит node ID в текущий flat index и вызывает virtualizer
  scrollToIndex. Edge auto-scroll не считать встроенным: отдельный renderer helper
  с одним RAF loop, последними dragover coordinates и rect scroll-container.
  Edge zone 32 px, скорость пропорциональна близости к краю, максимум 480 px/sec
  по RAF delta; позицию clamp по scrollHeight-clientHeight. Loop работает только
  при drag над container, останавливается на leave/drop/end/blur/unmount.
  Drag line размещается в координатах полного virtual content, не viewport rows.
- Запрет self/descendant move проверяется и в canDrop, и в command перед save.
  Отмена/недопустимый drop ничего не перемещает. Не удалять source в dragend.

## Последовательность реализации

1. **Spike зависимости**: одинаковые версии пакетов, React19 + Electron fixture:
   внешний task drag → дерево, internal folder move, hover expand, Escape,
   scroll, unmount во время drag. Если blocker, исправить adapter; не заменять
   автоматически Headless Tree на самописное дерево. Зафиксировать результат.
2. **Domain + repository**: schema, parent/placement index, commands,
   delete-with-promotion, load/save error path. Проверки критичных инвариантов.
3. **Общий presentation state**: сохранить legacy API/keys, single subscription
   source; pin/archive/rename обновляют список и tree одним действием.
4. **Panel controller и portal**: геометрия, hold reasons, идемпотентный drag
   lifecycle, меню/фокус, кнопка ручного открытия. Тест таймера и portal holds.
5. **Headless Tree adapter/UI**: folders/tasks/unfiled projection, virtualization,
   folder actions, task callbacks, archive styling, keyboard move chooser.
6. **Sidebar integration**: thin public entrypoint; handlers из legacy списка
   вынести в cohesive helper/component, чтобы GlobalTaskList не вырос.
   Никакого broad rewrite; preserve unrelated changes and memo/read-state logic.
7. **Desktop smoke и финальный review**: focused commands ниже, CDP screenshot
   открытой панели, реальный renderer drag и restart persistence на test fixture.

Ориентир изменений: 1200–2000 handwritten LOC плюс lockfile; это оценка после
уточнения scope, не лимит. Предпочитать один когерентный vertical slice; первый
checkpoint безопасен без UI только если не меняет текущую пользовательскую семантику.

## Edge cases и минимальные проверки

| Ситуация | Ожидаемый результат | Проверка |
|---|---|---|
| Drop, затем dragend, затем новый drag | Один timer; прежний callback не закрывает новую panel | fake timers/controller |
| Курсор уже внутри при release | Панель не закрывается | Electron drag smoke |
| Pointer в portaled context menu, focus в dialog | Панель удерживается до закрытия | interaction test |
| Folder в себя/потомка; повторный drop | Нет цикла/двойного placement | domain test |
| Reorder вниз в том же parent | Позиция не смещается на лишний элемент | domain + adapter assertion |
| A после B в `[A,B,C]` | before C после удаления A → `[B,A,C]`, без двойной коррекции | adapter assertion |
| Повторный вызов canDropForeignDragObject | Нет mutation/save; один onDrop → один commit | adapter interaction |
| Скрытый archive/unavailable между видимыми siblings | Canonical anchor сохраняет скрытые refs и порядок | adapter/domain assertion |
| Create/move/delete из внешней команды | Tree немедленно обновлён без collapse/expand | vendor adapter interaction |
| Delete nested/root folder с archived tasks | Promotion/unfiled без потери task refs/archive | domain test |
| Обновление каталога во время drag | Исчезнувшая задача/target отклонены, refs не чистятся | integration |
| Две быстрые move/create команды, save failure | Нет stale overwrite; последняя успешная revision верна | repository/controller test |
| Empty/invalid/newer schema; storage quota | Ничего не перезаписано, ошибку видно, список доступен | storage test |
| Archive/restore в любой поверхности | Одинаковый флаг и прежняя folder/order | shared-state interaction |
| Повторный mount/sidebar collapse | Нет утечки listeners/timers/overlay | interaction |
| Drag source выходит из viewport/исчезает при refresh | Source удержан или drag отменён; hold освобождён | desktop fixture |
| Pointer стоит у края без новых движений | RAF продолжает scroll, target line и drop верны | desktop fixture |
| 1000 задач, глубокие папки, узкое окно | Ограниченное число DOM rows, focus/drop прокручиваются | desktop fixture |

Tests должны падать при конкретных поломках выше, а не проверять исходный текст
или простые getters. Использовать `test/features/task-folders/` для критичных
domain/storage/controller/adapter контрактов и существующие sidebar regression
tests. Не создавать тест на каждый wrapper и не запускать live agent teams.

## Команды проверки при реализации

```bash
pnpm test -- test/features/task-folders test/renderer/components/sidebar/GlobalTaskList.test.ts test/renderer/components/sidebar/SidebarTaskItem.test.ts src/renderer/components/layout/Sidebar.test.tsx
pnpm lint:fast:files -- <точный список изменённых TS/TSX файлов>
pnpm typecheck
pnpm guard:source-file-size
pnpm lint
pnpm dev:mcp
```

Full lint оправдан новой feature boundary и legacy integration. Не запускать
дополнительный global tsc7. Для smoke использовать только sandbox/test fixture
через app test APIs, CDP 9222, без native folder picker и Computer Use.
Если fixture API отсутствует, добавить минимальный test-only injection путь,
не направлять проверку на реальные команды/проекты пользователя.
Изолировать и каталог задач (`AGENT_TEAMS_ELECTRON_CLAUDE_ROOT`), и Electron storage
(`AGENT_TEAMS_ELECTRON_USER_DATA_DIR`) уникальными test directories; restart
проверять с теми же test roots. Пример существующей изоляции:
`scripts/e2e/comment-notification-desktop.mjs`. Новый harness писать `.ts`, не `.mjs`.
Для текущего docs-only deliverable проверить ссылки и два review, не запускать build.

## Rollback

Revert UI integration отключает панель, не удаляет `taskFolders:v1` и legacy keys.
Не внедрять dual-write старых/новых архивов. Не сбрасывать папки автоматически
при rollback/ошибке. Новый snapshot version требует отдельной migration до записи.

## Acceptance criteria

- [ ] Начало task drag открывает прилегающую панель; drop/cancel сохраняет её
  минимум 2000 мс без hold reasons, hover/focus/edit/menu удерживают без ограничения.
- [ ] Кнопка открывает panel без drag; folder CRUD и вложенный folder/task DnD
  работают мышью; move chooser обеспечивает перенос с клавиатуры.
- [ ] Archive/restore не меняют папку/order; серые задачи доступны внутри папок.
- [ ] Restart сохраняет структуру; invalid storage/save error не теряют данные.
- [ ] Cycles, duplicate placement, wrong identities/external drags отклоняются.
- [ ] Current project/time/none, pin, archive-only, rename, unread/task detail
  сохраняют поведение и используют исходную identity.
- [ ] Нет native title tooltips в новом UI, vendor types/storage в domain,
  новых oversized files или роста frozen GlobalTaskList.
- [ ] Focused tests, typecheck, lint, size guard и Electron fixture smoke успешны.

## Два раунда review и исправлений

### Раунд 1: независимое review draft и исправления

Reviewer: subagent `plan_review`, read-only, GPT-6.1-sol / medium.
Проверены текущие sidebar, local state, UI primitives, feature standard и
официальные Headless Tree contracts. Принято и исправлено:

1. **P1, projected/canonical indices**: stable beforeChild/append anchors,
   скрытые refs сохраняются; root/system-node/unfiled ordering определён явно.
2. **P1, stale vendor view**: syncDataLoaderFeature + rebuild после committed
   projection, scheduleRebuildTree для React state, регрессия external mutations.
3. **P2, foreign dragover API**: разделены canDragForeignDragObjectOver,
   canDropForeignDragObject и onDropForeignDragObject.
4. **P2, исчезновение native drag source**: host-owned lifecycle, pin mounted
   virtual row, cancel при refresh удаления, capture/fallback cleanup.
5. **P2, edge auto-scroll**: конкретный RAF helper, edge zone/speed/cleanup,
   virtualized scrollToItem и drag line в full-content координатах.

Дополнительно уточнены узкое окно, name validation/IME, focus после CRUD и
изолированные storage roots для desktop smoke. Раунд 2 проверяет revised plan.

### Раунд 2: review исправленного плана и финальные исправления

Тот же read-only reviewer повторно прочитал revised plan. Подтвердил устранение
stale vendor view, native source lifecycle и edge auto-scroll. Выявил и уточнил:

1. **P1, validation с побочным эффектом**: основной DnD контракт теперь явно
   запрещает mutation в canDropForeignDragObject; единственный onDrop выполняет
   команду, обе границы повторно валидируют актуальную цель/identity. Добавлена
   проверка multiple canDrop calls → zero saves, single onDrop → single commit.
2. **P2, same-parent anchor**: next sibling выбирается после исключения source,
   vendor insertionIndex не корректируется дважды. Добавлены пример `[A,B,C]`
   и отдельное правило foreign task, который уже присутствует в целевой папке.

Дополнительная проверка virtualizer docs: зафиксированы stable getItemKey и
пересчёт pinned source index по node ID. После этих исправлений остаётся только
запланированная реализационная проверка React19/Electron spike; она не объявлена
выполненной. Два раунда review/fixes завершены, runtime исходники не изменены.
