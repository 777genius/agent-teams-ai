# План: список чатов + 1:1 тред в Messages

**Дата**: 2026-09-17
**Ветка / worktree**: `feat/team-direct-chats` → `.worktrees/feat-team-direct-chats`
**База**: `origin/main` @ `1672f53dd2`
**Статус**: нормативный implementation spec
**Эталон**: thin slice как `src/features/agent-graph`
**Оценка**: `🎯 8   🛡️ 8   🧠 6` · **~780 prod / ~780 test** новых + **80–150** перемещённых из frozen-файлов

Фиксирует *как делать*. Locked decisions не переоткрывать без нового критичного риска.

---

## Зачем

Messages сейчас — одна смешанная лента. Нужна навигация на том же месте:

1. Сначала список чатов (команда + каждый агент).
2. Клик открывает тот же timeline + composer, уже суженный под чат.
3. Back возвращает к списку.
4. На строке два пользовательских счётчика: весь непрочитанный activity и отдельно «написали **мне**». Preview предпочитает последнее сообщение пользователю.

Доставка уже адресная. Новый транспорт не нужен.

---

## Locked decisions

### Форма фичи

- `src/features/team-direct-chats`
- Thin: `core/domain` + `renderer`. Без `main/` / `preload/` / `contracts/` в v1
- Публичный вход: `@features/team-direct-chats/renderer`
- Тесты: `test/features/team-direct-chats/`
- README только навигационный
- Новые prod-файлы ≤ 800 строк

Не делать полный hexagonal. `getMessagesPage` / `sendMessage` уже есть.

### Две оси, не путать

| Ось | Значения | Кто владеет |
|---|---|---|
| Layout | `sidebar` / `inline` / `bottom-sheet` / `floating-composer` | как сейчас |
| Surface | `list` / `thread` | новая фича |

`floating-composer` список не показывает. Recipient: last **thread** scope если это `direct`, иначе lead как сейчас. Surface `list` для floating не считается выбранным чатом.

### ConversationScope

```ts
type ConversationScope =
  | { kind: 'team-feed' }
  | { kind: 'direct'; participant: string };
```

`team-feed` — первая строка («This team»). Без неё a2a и system пропадают.

Identity 1:1: `(teamName, user, participant)`. Same-team `conversationId` не вводим.

### Пайплайн данных (важно, раньше тут была дыра)

Не копировать правила `filterTeamMessages` в domain. Иначе noise/relay разъедутся.

```
effectiveMessages          // selectTeamMessages: merge + optimistic + coalesce
  → filterTeamMessages(    // noise, automation, relay-dupe, timeWindow
       filter: { from:∅, to:∅, showNoise:false },
       searchQuery: '',
       timeWindow: panel.timeWindow,
       leadNames
    )
  → visibleMessages
  → belongsToConversation(scope)   // только этот predicate в domain
  → scopedMessages
```

- **Список (preview + оба счётчика + header):** `visibleMessages` (canonical, без search/from-to).
- **Лента треда:** canonical + текущие search/from-to/showNoise + `belongsTo`.
- **Бейджи шапки треда и mark-all:** как список — canonical scoped, **не** search. Иначе поиск спрячет unread и mark-all прочитает только хиты.
- **Header списка:** уникальные ключи, не сумма строк. Два числа: unique unread и unique attention.

`isOutboundUserMessage(message)` — общий предикат для unread, attention и preview:

- `from === 'user'` **или**
- `source === 'user_sent'` / `cross_team_sent`

`isUserUnreadMessage(message, readSet, toKey)` только:

1. не outbound;
2. `toKey(message)` не в read-set;
3. **не смотреть** `InboxMessage.read`.

`toKey` в проде — существующий `toMessageKey`. Domain его не импортирует из `@renderer` и не копирует. Не «чинить» то, что ключ при непустом `messageId` возвращает сырую строку, а не trim.

`isAddressedToUser(message)`:

1. не outbound;
2. `trim(to).toLowerCase() === 'user'`.

Пустой `to` — **нет**. Не матчить OS/display name человека. Не использовать `isLeadThought` (это pending-reply, не attention).

Inbox reader уже подставляет missing `to` из имени файла (`inboxes/user.json` → `user`). Domain этому верит, feed/IPC не трогаем.

`isAttentionUnread = isUserUnread && isAddressedToUser`. Attention ⊆ unread.

Hidden-kinds отсекает `filterTeamMessages`, не эти helpers.

### Что входит в какой чат

Один `belongsToConversation(message, scope, leadNames)` на preview, тред и unread.

**team-feed:** `true`. Дальше режет `filterTeamMessages`.

**direct(P):** нормализовать `trim` + lower.

- пара `(user, P)` в любую сторону;
- если P — lead (имя из members или alias `lead` / `team-lead` / `teamlead` / `team-leader`): все same-team письма, где lead в `from` или `to` (включая `atlas → lead`), плюс пустой `to` с `source` `lead_session` | `lead_process`.

Не тащить в domain `isLeadThought` из renderer (compaction/noise). Noise всё равно снимет `filterTeamMessages`; timeline как сейчас не покажет protocol JSON.

Не входит в **member** 1:1: a2a другому мемберу, bootstrap не этому P, cross-team (`source` `cross_team` / `cross_team_sent` или `to`/`from` с `/`).
Письма мембер→lead входят в чат **лида**, не в чат отправителя.

Не использовать `selectMemberMessagesForTeamMember` и from/to AND-фильтр как 1:1.

### Два счётчика на строке чата

Один read-set, два числа из того же прохода. Не две системы прочитанности.

| Badge | Что считает | Цвет |
|---|---|---|
| **Activity** (база) | все unread в scope: a2a, system, thoughts, bootstrap, входящие | `Badge variant="secondary"` |
| **Attention** (оверлей) | unread **и** `to === 'user'` — агент написал пользователю | `Badge variant="default"` (high-emphasis / primary kit) |

Геометрия как у комментариев на канбане, **не** импортировать `UnreadCommentsBadge`:

```
[ 3 ]          ← secondary, весь unread
   └ [2]       ← default, top-right overlay, только to=user
```

- Activity 0 → бейджа нет.
- Attention 0 → только secondary.
- Оба > 0 → overlay, даже если числа равны (цвет = «это мне»).
- Скролл помечает оба: один ключ в read-set.

Примеры:

- `cody → oscar` непрочит. → This team activity+1, attention 0. Строка lead тоже activity+1. Строка cody без этого события.
- `alice → user` непрочит. → This team activity+1 и attention+1; строка alice то же.
- Lead thought без `to` → lead activity+1, attention 0.
- `system → lead` → This team activity+1, attention 0.
- `user → alice` → 0 (исходящее).

В таймлайне **не** красить attention отдельно. Только список (и шапка списка тем же маленьким виджетом).

### Preview

Feed после `mergeTeamMessages` — **newest-first**. `pickPreviewMessage(newestFirst)` без своей сортировки:

```
first isAddressedToUser(newestFirst)  ??  newestFirst[0]  ??  null
```

Не unread-only. `previewText` и `previewTimestamp` с **одного** выбранного сообщения.

View-model (не domain) режет текст через уже существующий sanitizer/summary, одна строка, truncate. Domain возвращает `InboxMessage | null`.

Следствия, не «чинить»:

- This team: свежий `cody → oscar` не затирает более ранний `alice → user`.
- Пользователь ответил позже — preview всё равно последний to-user, не «You: …».
- Unread=0, но to-user есть в голове — preview всё равно он.

### User-unread UX

- Список ничего не помечает.
- Тред — построчно существующим `onMessageVisible`. Не mark-all on open.
- «Mark all as read» **только этот scope**. Оба счётчика этого чата гаснут; другие чаты нет.
- Синие точки в треде: snapshot unread ключей **этого scope** на вход. Счётчики списка живые.
- Новые сообщения после входа в тред: в snapshot не входят, точка live, пока не доскроллил.
- `LeadThoughtsGroup` как сейчас: видна группа → все thoughts read. Не менять.
- Таймлайн IO / comment storage / `UnreadCommentsBadge` не трогать.
- Read store: апгрейд `teamMessageReadStorage` ключ `team-messages-read:<team>` + `subscribe`/`getSnapshot`. IndexedDB не тащить.

### Composer / route

- 1:1: `lockedRecipient={P}`, picker и cross-team target **выключены**.
- `onSend` в lock передаёт **проп**, не внутренний `recipient` (один кадр лага не должен уехать oscar). Плюс `useEffect` `setRecipient(P)` чтобы UI совпадал.
- team-feed: как сейчас.
- 1:1: скрыть `from → to`. team-feed: оставить.
- Auto-delegate при lead — как сейчас, в том числе в locked lead-чате.
- Черновик `composer:<teamName>` общий. Текст переезжает. В v1 так.

### Навигация

In-memory per team в `teamSidebarUiState`: `conversationSurface`, `conversationScope`. Не IDB.

- Первый заход в команду → `list`.
- Пока та же команда — помним list/thread + scope.
- Смена команды → `list`.
- Scope `direct` на removed/missing member → сбросить в `list`.
- Search query при смене scope очищать (иначе alice-поиск опустошит cody).
- Scroll: при смене surface/scope сбрасывать. Не плодить scrollTop на каждый чат.
- Back в bottom-sheet не закрывает шит.
- Клик по MemberBadge в ленте по-прежнему открывает профиль, не 1:1.

### Pagination v1

Фильтр уже загруженного feed.

Пустой **direct** тред + `hasMore` → авто `loadOlderTeamMessages`, пока не появится ≥1 scoped **или** `hasMore === false` **или** 8 страниц за одно открытие. Потом обычная кнопка Load older.

team-feed и список **не** автодочитывают историю ради preview. Preview/unread — по загруженной голове. Это осознанный потолок v1.

`getMessagesPage({ conversationScope })` — не v1.

### Чего не делаем

- новый inbox / IPC / HTTP messaging
- bubble-чат
- копипаста `MemberMessagesTab` / `MemberList` / `MemberCard`
- рост frozen выше cap
- generic chat SDK / общий `useViewportItemRead`
- browser HTTP parity
- cross-team пунктом списка
- per-chat draft
- сортировка чатов по last message
- чаты removed-мемберов
- отдельный attention persist / нотификации / точки attention в таймлайне

---

## Frozen caps

| Файл | Сейчас | Cap | Запас |
|---|---:|---:|---:|
| `MessageComposer.tsx` | 1342 | 1344 | 2 |
| `ActivityItem.tsx` | 1991 | 1991 | 0 |
| `ActivityTimeline.tsx` | 1073 | 1073 | 0 |
| `MessagesPanel.tsx` | 1657 | 1722 | 65 |

65 строк панели не тратить на picker. Extract + новые файлы.

Extract без смены поведения:

1. recipient picker из composer
2. `recipientBadge` из `ActivityItem`
3. `MessageRowWithObserver` из timeline — иначе нельзя прокинуть `showRecipientRoute`

---

## Целевое дерево

```text
src/features/team-direct-chats/
  README.md
  core/domain/
    conversationScope.ts
    belongsToConversation.ts
    isUserUnreadMessage.ts          # + isAddressedToUser, в одном файле
    countUnreadByConversation.ts
    pickPreviewMessage.ts
    buildChatList.ts
  renderer/
    index.ts
    hooks/useTeamConversationSurface.ts
    view-models/chatListViewModel.ts
    ui/TeamMessagesSurface.tsx
    ui/ChatList.tsx
    ui/ChatListRow.tsx
    ui/ChatUnreadBadges.tsx
    ui/ConversationHeader.tsx
```

Read store остаётся в `src/renderer/utils/teamMessageReadStorage.ts` (тот же ключ, добавить notify). Хук `useTeamMessagesRead` перевести на `useSyncExternalStore`. Отдельный store-файл в фиче не плодить.

`buildChatList` принимает **уже visible** messages.

---

## Domain

### `belongsToConversation`

См. locked. Тесты:

- user→alice / alice→user ∈ alice и team-feed
- cody→oscar ∉ alice, ∈ team-feed
- system без пары с P ∉ 1:1, ∈ team-feed
- lead thought (`lead_process`, пустой to) ∈ lead, ∉ alice
- user→lead ∈ lead
- `otherTeam/oscar` / `source: cross_team` ∉ local 1:1
- bootstrap `lead → oscar` ∈ oscar и team-feed (это обычная пара from/to)
- missing to у не-lead source ∉ 1:1

### `countUnreadByConversation`

Один проход по `visibleMessages`. На каждый scope: `{ unreadCount, attentionCount }`. `toKey` снаружи.

- team-feed: все unread visible / из них `to=user`
- direct(P): unread ∩ belongsTo(P) / из них `to=user`

Одно `alice → user` даёт activity+attention на alice **и** на team-feed. Сумма строк ≠ header.

Header: `|unique unread keys|` и `|unique attention keys|`.

### `buildChatList`

Порядок: team-feed, lead, остальные `activeMembers` как в props (без sort по времени).

Поля: `scope`, `displayName`, `member?`, `previewText`, `previewTimestamp`, `unreadCount`, `attentionCount`.

Preview: `pickPreviewMessage` на newest-first scoped visible. Пустой чат всё равно в списке.

Solo (только lead): всё равно две строки — This team и lead. Не схлопывать. В solo team-feed держит system/bootstrap, lead-чат — thoughts + DM.

Removed мемберы в список не входят (`activeMembers`, как composer). Их история остаётся в team-feed.

---

## Edge cases (locked)

**Relay / optimistic.** Считать после `filterTeamMessages` и `selectTeamMessages`. Иначе user_sent + runtime_delivery = два unread.

**timeWindow.** Session filter канбана уже приходит в панель. List unread/preview и тред его чтят. Это не баг.

**showNoise.** Список всегда canonical `false`. В треде пользователь может включить noise — лишние строки не входят в list badge. Ок.

**Search / from-to.** Только тред. На список не влияют. При смене scope search сбрасывается.

**Mark all.** Только текущий scoped набор.

**Ключи без messageId.** Как сейчас: `timestamp-from-text`. Не выдумывать uuid.

**Авто-load 1:1.** Максимум 8 страниц на открытие. Не крутить на list.

**Новое сообщение в списке.** Badge/preview live, чат сам не открывается.

**Новое сообщение в треде.** Если строка в viewport — существующий IO пометит. Autoscroll таймлайна не менять.

**Стейл alice.** Member пропал → list. `lockedRecipient` не шлёт в никуда.

**Cross-team.** Только team-feed. В 1:1 composer cross-team disabled.

**Квалифицированные имена.** `team/member` не матчится на локальный `member`.

**Draft bleed.** Текст общий. Адресат = текущий lock/picker. Не чистить draft при Back.

**Revision.** В 1:1 в таймлайне только сообщения этого чата, revise остаётся этому P. Отдельной защиты не писать.

**Pending replies.** Это «ждём ответ агента», не unread. StatusBlock только в треде. Не рисовать pending на строке чата в v1.

**Клики по имени в ленте.** Профиль, не switch chat.

**Layout switch.** sidebar↔sheet помнит surface/scope. Floating не рисует list.

**Два хоста.** В каждый момент один `MessagesPanel` (sidebar vs graph sheet). State в `teamSidebarUiState` общий — ок.

**Virtualization.** IO только на смонтированных рядах, как сейчас.

**a11y.** Строка — button, `aria-label` имя + activity + attention. Back — `messages.chats.back`. Native `title` нельзя.

**i18n.** Ключи в `en/team.json` (+ `resources.d.ts`, если типы не из json). `fallbackLng` = `en`. `ru` по желанию, 29 локалей не трогать.

**Пустой тред.** «Нет сообщений» + composer. Не путать с «нет мемберов».

**Bootstrap start.** `lead → oscar` капает activity oscar и This team, attention нет (`to` не user).

**Attention vs thoughts.** Lead thoughts без `to` — только activity. Официальный `lead → user` — activity+attention. Это и есть «агент что-то делает» vs «агент написал мне».

**Attention не выводится из пустого `to`.** Иначе thoughts станут «нужно тебе».

**Оба бейджа из одного read-set.** Не отдельный attention-store.

**Preview to-user может быть уже прочитан.** Unread=0, preview всё равно последнее письмо пользователю, если оно есть в загруженной голове.

**Не путать attention с pending-reply.** `messagesPanelLogic` считает lead thoughts ответом пользователю. Счётчик «мне» так не делает.

**Не нормализовать `to` против filename в renderer.** Reader уже заполнил missing `to`. Лишний слой разъедется с lead thoughts (пустой `to` на сессии, не inbox).

---

## UI

### List

Шапка: Messages + `ChatUnreadBadges` по unique counts. Без «31 messages». Без mark-all, search, collapse-all.

Строка: `MemberBadge` / presence, имя, preview (to-user first), время, `ChatUnreadBadges`. Клик → thread.

`ChatUnreadBadges` — один `relative inline-flex overflow-visible` вокруг activity `Badge variant="secondary"`. Attention — меньший `Badge variant="default"` (`absolute -right-1 -top-1`, `h-4 min-w-4`, `text-[8px]`). Это kit-primary (`bg-text` / `text-surface`), не новый variant и не kanban `bg-blue-500`.

- Полные числа, не 9+.
- Overlay `pointer-events-none`; клик — у строки.
- Строка `overflow-visible`, иначе overlay обрежется.
- Tooltip Radix на стек: activity vs addressed-to-you. Native `title` нельзя.
- `aria-label` оба числа.

This team: иконка команды / MessageSquare, не аватар lead.

Не копировать `UnreadCommentsBadge` (иконка + total comments). Только геометрия оверлея.

### Thread

Шапка: Back, имя, live `ChatUnreadBadges` этого scope, mark-all, search/filter, collapse, layout menu.

Тело: StatusBlock + composer + timeline.

```
scoped = belongsTo(filterTeamMessages(effective, panelOptions), scope)
```

`panelOptions` здесь уже с search/from-to/showNoise.

### Host

```
floating-composer → composer only
list              → ChatList в слоте content
thread            → composer + status + timeline
```

Не копировать четыре layout-ветки. Graph hook не трогать.

---

## i18n ключи

```
messages.chats.teamFeed
messages.chats.back
messages.chats.emptyList
messages.chats.emptyThread
messages.chats.emptyPreview
messages.chats.rowAria        // "{{name}}, {{unread}} unread, {{attention}} for you"
messages.chats.activityUnread
messages.chats.attentionUnread
```

`messages.unread.*` уже есть.

---

## Порядок работ

Сначала policy, потом UI.

1. Domain + тесты (`belongsTo`, unread vs attention, preview prefers to-user, unique vs per-row, cross-team, bootstrap, solo).
2. Extract frozen (composer picker, route, message row). Pending-send тесты зелёные.
3. Read store subscribe. Два подписчика видят markRead. Старый ключ жив.
4. Presentational ChatList / header.
5. Hook: surface, stale scope, search reset, 8-page older cap, snapshot.
6. Вставить в MessagesPanel. Заменить `!m.read && !readSet` на `isUserUnreadMessage` по **visible** messages.
7. `lockedRecipient` + disable cross-team + `showRecipientRoute`.
8. i18n en (+ types).
9. Host-тесты из списка ниже.
10. `pnpm` targeted test, typecheck, `guard:source-file-size`, `lint:fast:files`.

Один PR на ветке нормален. Отдельный extract-PR только если extract раздуется.

---

## Карта файлов

| Файл | Изменение | Cap |
|---|---|---|
| `MessageComposer.tsx` | extract picker; `lockedRecipient`; disable cross-team when locked | ≤1344 |
| `ActivityItem.tsx` | extract route; `showRecipientRoute` default true | ≤1991 |
| `ActivityTimeline.tsx` | extract row; прокинуть `showRecipientRoute` | ≤1073 |
| `MessagesPanel.tsx` | host surface; unread formula; scoped mark-all | лучше сжать |
| `teamMessageReadStorage.ts` | subscribe/notify | |
| `useTeamMessagesRead.ts` | `useSyncExternalStore` | |
| `teamSidebarUiState.ts` | surface + scope | |
| `en/team.json` | ключи | |
| тесты панели / composer / domain | | |

Не трогать: feed service, IPC, `commentReadStorage`, `MemberMessagesTab`.

---

## Тесты минимум

Domain: пары, a2a только activity, `alice→user` оба счётчика, thoughts только activity, preview first-to-user в newest-first даже если индекс 0 — a2a, timestamp preview = выбранному сообщению, outbound не attention, bootstrap∈oscar без attention, `read:true` всё ещё unread, unique header ≠ сумма строк.

Store: второй подписчик, persist, scoped mark-all не затирает чужие ключи.

Renderer: list→thread→back; lock recipient; team-feed без lock; a2a только secondary; `to=user` overlay; preview не сбивается следующим a2a; search в треде не меняет list/header badges; open thread без viewport не zero; snapshot точка живёт после live mark; stale member → list; floating без списка; auto-older останавливается на 8.

Не live e2e. Не real projects.

---

## Acceptance

1. Sidebar открывается списком, не лентой.
2. Есть This team и строка на каждого active мембера.
3. 1:1 = user↔агент; lead ещё thoughts.
4. Team-feed ≈ сегодняшняя лента.
5. Back → список.
6. Unread = пользовательский read-set. Агентский `read` не гасит.
7. a2a/system — только secondary. Входящее `to=user` — secondary + primary overlay. Preview в этом случае — последнее to-user.
8. Скролл построчно. Open ≠ read all.
9. 1:1 без route и без смены recipient / cross-team.
10. Layout modes живы. Floating без списка.
11. File-size зелёный.
12. Ключ `team-messages-read:` не мигрируем и не теряем.
13. Header unread на списке не суммирует alice+team-feed вдвойне.
14. Mark all в alice не читает oscar/team-feed.

---

## Объём

| Кусок | Prod | Tests |
|---|---:|---:|
| Extract | 20–40 net / 80–150 move | 40–80 |
| Domain | 180–260 | 300–450 |
| ChatUnreadBadges | 40–70 | 30–50 |
| Read store notify | 40–80 | 70–110 |
| ChatList + surface | 220–320 | 100–160 |
| Hook | 90–150 | 80–130 |
| Host | 40–80 | 50–90 |
| lock + hide route | 30–60 | 40–70 |
| i18n | 20–40 | — |
| **Середина** | **~780** | **~780** |

Не добавлять IO-унификатор с комментариями и не делать feed-query в этой ветке.

---

## Фаза 2 (не сюда)

- `getMessagesPage` по scope, когда 8 страниц мало
- per-chat draft
- `MemberMessagesTab` на `belongsToConversation`
- чаты removed-мемберов
- сортировка по last message
- отдельный attention read-set / нотификации / точки attention в таймлайне

---

## Quick path

1. Domain tests green.
2. Extract, cap не вырос.
3. Subscribe read store.
4. ChatList.
5. Host.
6. Lock / hide route.
7. Snapshot + scoped mark-all.
8. Guards.
