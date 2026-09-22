# Agent Graph - Stable Slot Layout Plan

## Статус

- Дата фиксации: `2026-04-15`
- Выбранный подход: `Variant 3 - stable sectors around lead`
- Оценка выбранного подхода: `🎯 8   🛡️ 9   🧠 8`
- Примерный объём: `500-1100 строк + тесты + cleanup`
- Тип документа: `implementation spec`

Этот документ считается **нормативным** для следующей большой переделки layout графа.

Если в документе что-то сформулировано как "фиксируем", "обязательно", "не делаем", это уже не brainstorming, а зафиксированное решение. Переоткрывать такие решения в процессе реализации не нужно, если только не найден новый критичный риск.

## Нормативность разделов

Чтобы не было путаницы между spec и advisory-текстом, фиксируем это явно.

### Нормативные разделы

Нормативными считаются все разделы, которые описывают:

- model / topology
- stable identity
- storage/source of truth
- geometry contracts
- planner rules
- validation / commit behavior
- drag / fit / filter semantics
- acceptance criteria
- test plan

Именно они определяют, как feature должна работать.

### Advisory разделы

Advisory-разделами считаются:

- `Recommended PR split`
- `Что ещё можно тюнить без изменения архитектуры`
- примеры псевдокода, если они не противоречат более строгим правилам выше

Они помогают выполнять refactor, но не имеют права переопределять core rules.

### Правило при конфликте

Если пример, псевдокод или PR-split визуально расходятся с более строгим invariant/rule/acceptance пунктом, побеждает более строгий invariant/rule/acceptance пункт.

## TL;DR

Мы уходим от текущей полусвободной схемы, где owner-зоны лечатся локальными packer-ами и overlay-хитростями, и переходим к более стабильной модели:

- `lead` остаётся в центре
- каждый `member` получает **свой slot**
- slots распределяются **по стабильным секторам вокруг lead**
- если места не хватает, используется **second ring**, а при необходимости и следующие outer rings
- внутри каждого slot layout всегда один и тот же:
  - `Activity` сверху
  - `Member` в центре
  - `Process` как attached sub-rail
  - `Tasks` снизу
- drag сохраняет не `x/y`, а `slot assignment`
- `tasks` bounded по высоте до `5` visible rows
- `activity` bounded до `3` items
- все active non-empty kanban columns показываются, а `slot width` увеличивается, чтобы их вместить

Главный результат, который должен почувствовать пользователь:

- у каждого участника есть своё место
- `Activity` и `Tasks` больше не налезают на чужие зоны
- zoom/pan больше не создают ощущение, что owner-local UI "плавает" отдельно от диаграммы
- dense teams читаются стабильнее и предсказуемее

## Quick decision table

Чтобы implementer не листал весь документ ради очевидного ответа, фиксируем самые важные развилки прямо здесь.

- `lead` - не обычный member slot, а `central reserved block`
- `member` - получает `member sector slot`
- `unassigned tasks` - получают `special slot` под lead только если такие задачи реально есть в dataset
- `showTasks/showProcesses/showEdges` - скрывают presentation, но не меняют layout topology
- `graph tab/fullscreen` - шарят layout state, но могут иметь разный camera state
- `slotAssignmentsByTeam` - хранит только member sector assignments
- `teamName` в `v1` - storage scope key для layout state
- `member.name -> agentId` - one-time migration, если version не сбрасывался
- `team rename` - автоматическая миграция layout state не входит в этот refactor
- `no lead in dataset` - новый planner не должен пытаться строить stable sectors без lead

## State transition matrix

Это краткая operational-шпаргалка: какое событие что именно имеет право менять.

| Событие | Меняется owner set | Меняется slot assignment | Меняется camera state | Нужен planner run | Примечание |
|---|---|---:|---:|---:|---|
| `zoom / pan` | нет | нет | да | нет | только camera transform |
| `showTasks / showProcesses / showEdges` | нет | нет | нет | нет | меняется только presentation |
| новый `message/comment` без роста footprint | нет | нет | нет | нет | activity content update only |
| process content update без роста reserved band | нет | нет | нет | нет | process presentation only |
| growth owner footprint | нет | возможно | нет | да | partial replanning only |
| `member add` | да | да | нет | да | новый owner ищет первый valid slot |
| `member remove/hide` | да | нет для остальных | нет | возможно | без global compaction |
| hidden member reappears | да | обычно нет | нет | возможно | сначала пробуем старый assignment |
| drag/drop owner | нет | да | нет | да | snap/swap path |
| `member.name -> agentId` | нет | возможно | нет | возможно | one-time migration before planner |
| team switch | да, scoped | нет | да | нет | просто переключаем team-scoped state |
| team rename | зависит от storage key | как новый scope в `v1` | нет | возможно | auto-migration не входит |
| no lead transient state | dataset invalid для planner | нет | нет | нет | safe fallback only |

## Coder Start Here

Если начинать реализацию прямо сейчас, безопасный порядок такой:

1. Сначала протянуть `agentId` и перевести owner identity на `stableOwnerId`
2. Потом вынести pure planner helpers и покрыть их unit tests
3. Потом добавить `slotAssignmentsByTeam` как новый source of truth
4. Потом интегрировать planner в owner placement
5. Потом привязать `Tasks`, `Process`, `Activity` к `slot frame`
6. Потом сделать drag/snap/swap
7. Потом удалить старые geometry paths

Нельзя начинать с UI и рисования activity/task zones поверх старой geometry - это почти гарантированно снова создаст двусмысленность и временные баги.

## Responsibility split by layer

Чтобы реализация не размазала layout-логику по разным React paths, фиксируем ownership заранее.

### Data / adapter layer отвечает только за content model

Сюда относится:

- `stableOwnerId`
- grouping задач, activity и process-данных по owner-у
- вычисление active non-empty kanban columns
- подготовка content metadata для task/activity/process bands

Сюда **не** относится:

- вычисление world positions
- slot assignment
- screen-space correction
- DOM measurement

### Layout / planner layer отвечает только за topology и geometry

Сюда относится:

- `OwnerFootprint`
- `slotAssignmentsByTeam`
- `SlotFrame`
- ring / sector planning
- collision / exclusion validation
- fit bounds

Сюда **не** относится:

- отрисовка текста
- hover state
- tooltip placement
- post-render visual "подталкивание" lane-ов

### Renderer / interaction layer отвечает только за presentation

Сюда относится:

- drawing canvas / DOM content внутри уже готового `SlotFrame`
- hit testing
- hover / selection / popover
- drag preview и commit нового assignment

Сюда **не** относится:

- решение cross-owner overlap
- самостоятельный пересчёт slot width/height
- отдельный layout path для fullscreen vs tab

## Persistent vs derived state

Одна из главных вещей, которую нельзя оставить "по ощущениям" - что именно мы храним, а что каждый раз честно пересчитываем.

### Persistent state

Храним только то, что реально должно переживать refresh и reopening:

- `slotAssignmentsByTeam[teamName][stableOwnerId]`
- `slotLayoutVersion`

Опционально можно хранить технические timestamp/debug markers, но они не должны становиться источником истины для geometry.

### Derived state

Каждый planner run заново считает:

- `visible owner set`
- `OwnerFootprint`
- `lead central reserved block`
- `runtimeCentralExclusion`
- `SlotFrame[]`
- `fit bounds`
- band-local anchors

### Session-local last valid snapshot cache

Для `v1` дополнительно допускается **только session-local** cache последнего валидного `StableSlotLayoutSnapshot` по `teamName`.

Это не persistent source of truth для placement, а технический safety/cache layer.

#### Что это значит

- assignments остаются source of truth для member placement
- snapshot cache не заменяет assignments
- snapshot cache не пишется в config/main/storage как обязательная часть этого refactor
- snapshot cache используется только для safe handoff между planner runs и для fail-closed поведения

#### Что нельзя делать

- использовать snapshot cache как новую альтернативу `slotAssignmentsByTeam`
- восстанавливать из него layout identity независимо от текущих assignments
- silently коммитить stale snapshot как будто это новый валидный planner result

### Что принципиально не должно быть persistent

- raw `x/y`
- screen-space coordinates
- post-render measured widths/heights
- activity/process/task band positions
- `lead central reserved block`
- `unassigned task slot`

Иначе layout снова станет зависеть от случайного порядка рендера и старых геометрических хвостов.

## Hard invariants

Ниже набор правил, которые нельзя нарушать в реализации даже временно, если только это не изолированный промежуточный локальный WIP.

- owner placement source of truth - это `slot assignment`, не raw `x/y`
- `lead` всегда центральный anchor
- slot contents всегда upright и не ротируются по sector angle
- `activity band`, `process band`, `task band` bounded по высоте
- все `active non-empty` kanban columns показываются
- slot width может расти, slot height по bands остаётся bounded
- вся slot geometry считается в `world coordinates`, а не в screen-space
- planner не читает размеры из DOM и не зависит от post-render measurement
- zoom/pan меняют только camera transform
- planner сохраняет existing placements whenever still valid
- старый pack/force/pinning path не должен параллельно переопределять новый planner

## Что не входит в этот план

Этот документ описывает именно **layout refactor для owner-local zones**.

В этот pass не нужно заново переоткрывать или смешивать сюда:

- redesign review semantics
- новые edge interactions
- minimap
- timeline
- particles redesign
- отдельные эксперименты с process content semantics
- отдельные refactor-ы не связанные с owner slot geometry

Если что-то из этого потребуется, это должен быть отдельный spec, а не тихое расширение этого плана.

## Зачем нужен новый layout

Текущая схема уже лучше, чем старый overlay-path, но всё ещё имеет системную проблему:

- `Activity` и `Tasks` конкурируют за одно и то же пространство
- owner-local зоны удерживаются постфактум через packer и визуальные коррекции
- при большом числе участников диаграмма становится слишком зависимой от текущей геометрии и порядка обновлений
- поведение при refresh, zoom, плотном графе и смене количества задач остаётся недостаточно предсказуемым

Пользовательский приоритет в этой фиче уже явно выбран:

- меньше "живой физики"
- больше стабильности
- больше читаемости
- больше правдивой резервации места под owner-local UI

## Что зафиксировано окончательно

Ниже список решений, которые уже приняты.

## 1. Общая модель layout

- Используем `stable sectors around lead`
- Не возвращаемся к полностью свободной раскладке owners
- Не делаем "одна жёсткая колонка строго вниз"
- `lead` остаётся в центре как отдельный central reserved block
- `members` располагаются вокруг `lead`, и каждый `member` живёт внутри собственного вертикального slot
- `unassigned tasks`, если они есть, живут в отдельном нижнем bounded slot под `lead`

## 1.1. Кто получает layout-reserved место

Чтобы не было разной трактовки состава layout actors, фиксируем это явно.

### Central reserved block получает

- `lead`

`Lead` получает не обычный `member slot`, а свой отдельный центральный reserved block.

### Sector slot получают

- каждый **видимый активный member**, который участвует в текущем graph owner set

### Conditional special slot получает

- `unassigned tasks`, если в текущем visible graph dataset есть хотя бы одна такая задача

### Slot не получают как самостоятельные owners

- tasks
- processes
- particles
- edges
- removed members, если они не должны быть видимы по текущему graph visibility rule

То есть:

- у `member` есть sector slot
- у `lead` есть central reserved block
- у `unassigned tasks` есть отдельный special slot только когда он реально нужен
- `tasks/process/activity` - это внутренние band-ы slot-а или central block-а, а не самостоятельные owners

## 2. Lead

- `lead` остаётся центральным anchor
- `lead` не является обычным `member slot`
- `lead` не участвует в обычном drag/snap flow
- `lead` всегда остаётся в центре layout
- `launch HUD` для `lead` остаётся отдельной reserved zone
- `lead activity` тоже остаётся отдельной reserved zone, но входит в central exclusion
- `lead` не участвует в member ring planner как ещё один slot candidate
- `lead` не получает обычный member-style `task band`
- Для `v1` фиксируем default стороны:
  - `lead activity` - слева от lead
  - `launch HUD` - справа от lead

### Важное уточнение

Для `v1` `lead activity` использует те же bounded activity rules:

- `3` visible items
- `+N more`
- `newest first`

## 3. Activity

- `Activity` является частью owner slot, а не отдельным свободным overlay-режимом
- Видимых элементов: `3`
- Порядок: **newest first**
- После них показывается `+N more`
- `+N more` открывает профиль участника сразу на вкладке `Activity`
- В activity feed попадают и `messages`, и `comments`
- У комментария target - это `task`, а не другой участник
- Для activity нужно переиспользовать уже существующий compact UI сообщений, а не придумывать новый визуальный язык

## 4. Tasks

- Task area живёт внутри owner slot
- Сохраняем current multi-column kanban semantics
- Видимая высота task band ограничена `5` rows
- Все **активные non-empty** kanban columns показываются
- Если колонок больше, `slot width` увеличивается
- Не вводим scroll внутри slot как основную механику
- Не скрываем колонки только ради того, чтобы "поместилось"
- Внутри колонки сохраняем текущую каноническую task order semantics, а не придумываем новый sort-rule в рамках этого refactor

## 4.1. Unassigned tasks

Так как в системе могут быть задачи без owner-а, это тоже нужно зафиксировать.

### Правило для v1

- задачи без owner-а не теряются
- они не распределяются случайно по member slots
- для них используется отдельный `unassigned task slot`

### Где он живёт

- `unassigned task slot` располагается в нижней части central area, под lead
- он не участвует в member ring placement
- он не draggable
- он создаётся только если есть хотя бы одна видимая unassigned task

### Что происходит при его появлении или исчезновении

- это может расширить нижнюю central exclusion зону
- planner может локально вытолкнуть конфликтующие нижние member slots дальше
- это не должно вызывать глобальный reshuffle всех owners

### Что внутри

- только `task band`
- без `activity band`
- без `process band`
- bounded по тем же правилам:
  - `5 rows`
  - все active non-empty columns
  - overflow stack per column

Это отдельный pseudo-owner case, чтобы planner не терял нераспределённые задачи и не пытался притвориться, что их не существует.

## 5. Process

- Process остаётся в диаграмме
- Process становится owner-local
- Process отображается как маленький attached sub-rail участника
- Текущий визуальный стиль process хорош и должен быть переиспользован
- Process должен учитываться в slot footprint

## 6. Drag

- Drag owner разрешён
- После отпускания owner снапается в ближайший slot
- Если slot занят, по умолчанию делаем `swap`
- Raw `x/y` не сохраняем как источник истины
- Сохраняем именно `slot assignment`

## 7. Stable identity

- Основной стабильный идентификатор участника: `config.members[].agentId`
- Fallback: `member.name`
- `ResolvedTeamMember` должен получить `agentId?: string`
- Все layout-решения должны жить на stable owner id, а не на display name

### Контракт уникальности

План исходит из того, что внутри одной команды:

- `agentId` уникален, если он присутствует
- `member.name` уникален в fallback-режиме

Если это нарушено, реализация не должна тихо склеивать двух owners в один.

Обязательное поведение:

- в dev/test - явный assert или error
- в runtime - явный warning/error path без silent merge

## 8. Width buckets

- Используем `S / M / L`
- Buckets нужны для packing/planning
- Buckets не имеют права обрезать контент
- Buckets не подменяют реальную ширину выдуманной константой

## 9. Second ring

- `Second ring` нужен
- Ring capacity считаем по footprint / budget, а не по тупому member count
- Нельзя строить правило вида "до 10 участников один круг, потом второй"
- В `v1` у каждого ring есть `6` canonical sector anchors, то есть номинально один ring не может вместить больше `6` owners
- Реальная usable capacity ring-а может быть **меньше**, если какие-то slot frames не проходят по footprint / exclusion / gap constraints
- То есть spill на outer ring определяется не условием `memberCount > N`, а реальной валидностью candidate frames
- `Second ring` здесь - это shorthand для outer-ring model. Planner не должен останавливаться ровно на двух rings, если команда реально крупнее

## 10. Сектора

- Для `v1` фиксируем `6` секторных направлений вокруг lead
- Порядок секторов - по часовой стрелке, начиная сверху:
  - `top`
  - `upper-right`
  - `lower-right`
  - `bottom`
  - `lower-left`
  - `upper-left`
- Следующий ring использует те же sector ids

## Уточнения, которые снимают двусмысленность

Ниже решения, которые нужно понимать **однозначно**, чтобы не было разных трактовок при реализации.

## 1. Что значит "видно 5 задач"

Это **не** "5 задач суммарно на весь slot".

Это значит:

- task band имеет высоту `5 rows`
- каждая kanban column внутри этого band может использовать максимум `5 visible rows`
- если колонка переполнена, последний visible row превращается в overflow stack

То есть для overflowing column действует правило:

- `4 реальных pills + overflow stack`

Высота task band остаётся постоянной.

## 2. Что значит "видно 3 activity"

Это значит:

- в activity band показываются `3` реальных activity items
- ниже может быть отдельный footer `+N more`
- footer не считается "четвёртым activity item"

## 3. Что значит "все колонки показываем"

Это значит:

- не ограничиваем число видимых **active non-empty** kanban columns
- не вводим horizontal scroll
- не делаем "покажи первые 3, остальные спрячь"
- если активных колонок стало больше, `slot width` должен вырасти

Это **не** значит, что нужно внезапно начать показывать пустые canonical columns, которых раньше на доске не было видно. Текущее правило "показываем только active non-empty columns" сохраняется.

### Что считается active non-empty column

Для этого плана колонка считается `active non-empty`, если в ней есть хотя бы одна task, которая должна быть видима в owner task zone до применения overflow-stack подрезки.

Проще говоря:

- пустые канонические колонки не показываем
- колонка с задачами показывается, даже если часть задач ушла в overflow stack

## 4. Что именно bounded

Bounded должны быть:

- высота activity band
- высота process band
- высота task band

Не bounded:

- число kanban columns
- общая slot width

## 5. Когда layout может двигаться

Layout **может** менять slot placement только в понятных случаях:

- добавился новый участник
- удалился участник
- пользователь вручную перетащил участника
- owner slot реально вырос по footprint настолько, что текущий ring больше не может его честно вместить
- пользователь явно нажал reset layout

Во всех остальных случаях layout placement меняться не должен.

Во всех остальных случаях layout **не должен** перескакивать.

## 6. Когда layout не должен двигаться

Layout не должен менять slot placement из-за:

- zoom
- pan
- нового message/comment
- смены unread count
- появления или исчезновения process rail, если footprint band остаётся в пределах резерва
- rename, если `agentId` тот же
- изменений данных внутри уже существующих visible rows, если slot footprint не меняется

## Негативные решения - что сознательно не делаем

Эти варианты сознательно отклонены и не должны "случайно вернуться" в код под видом быстрых фиксов.

- Не продолжаем лечить owner overlap screen-space packer-ом как основным механизмом
- Не сохраняем raw `x/y` для owner layout
- Не возвращаем owner placement под свободный d3-force
- Не вводим local scroll внутри slot как первую механику
- Не скрываем kanban columns ради fit
- Не оставляем process floating отдельно от owner
- Не делаем агрессивный auto-compact всех owners при каждом member remove

## Канонические термины

Чтобы не путаться в названиях при реализации:

- `owner` - `lead` или `member`, вокруг которого строится локальная зона
- `stableOwnerId` - стабильный id участника, построенный из `agentId` или fallback на `name`
- `slot` - общий разговорный термин для layout-reserved зоны, но в коде лучше не использовать его без уточнения
- `member sector slot` - обычный slot участника, который реально планируется ring/sector planner-ом
- `special slot` - специальная зарезервированная зона, не живущая в member assignments, например `unassigned task slot`
- `central reserved block` - специальная центральная зона lead-а
- `sector` - одно из 6 направлений вокруг lead
- `ring` - круг уровнем дальше от lead
- `slot assignment` - привязка **member sector slot** к `(ringIndex, sectorIndex)`
- `slot frame` - прямоугольник **member sector slot** в world coordinates, если отдельно не сказано иное
- `central exclusion` - запрещённая зона вокруг lead, учитывающая lead, launch HUD и lead activity
- `task band` - нижняя часть slot, где живёт kanban
- `activity band` - верхняя часть slot
- `process band` - узкая зона между owner и task band

### Runtime central exclusion

Чтобы не было разной трактовки в коде, под итоговым `runtime central exclusion` в этом документе понимается:

```ts
runtimeCentralExclusion =
  union(
    leadCentralReservedBlock,
    optionalUnassignedTaskSlot
  ) + centralSafetyPadding
```

То есть нижний `unassigned task slot`, если он существует, становится частью итоговой центральной запрещённой зоны для member slot planner-а.

## Целевая визуальная схема

```text
                         [ Activity x3 ]
                         [ Member A    ]
                         [ Process     ]
                         [ Tasks x5    ]


 [ Activity x3 ]                                  [ Activity x3 ]
 [ Member B    ]          [ Lead ]                [ Member C    ]
 [ Process     ]      [ Launch HUD ]             [ Process     ]
 [ Tasks x5    ]                                  [ Tasks x5    ]


                         [ Activity x3 ]
                         [ Member D    ]
                         [ Process     ]
                         [ Tasks x5    ]
```

Если owner slots не помещаются в ring 1 честно, следующий owner уходит в ring 2, а не пытается "додавиться" между соседями.

## Точная структура slot

Каждый member slot строится по одинаковой схеме.

### Политика резервации места

Slot резервирует геометрию под все свои bands **всегда**, даже если в конкретный момент band визуально пустой.

Это значит:

- пустой `Activity` band может не рисовать карточки, но его высота зарезервирована
- пустой `Process` band может не рисовать rail, но его высота зарезервирована
- пустой `Task` band может не рисовать tasks, но его высота зарезервирована

Это осознанный tradeoff ради того, чтобы slot не прыгал по высоте при каждом изменении данных.

### Slot local anatomy

1. `Activity band`
2. `Owner band`
3. `Process band`
4. `Task band`

### Activity band

- расположен сверху slot
- имеет фиксированную высоту под:
  - `3 activity items`
  - `+N more footer`
- footer height резервируется всегда, чтобы не было layout jump
- connector к owner рисуется короткий и локальный
- если activity entries сейчас нет, band остаётся пустым визуально, но не схлопывается геометрически

### Owner band

- содержит сам `member node`
- owner node является точкой привязки локального layout
- label / role / runtime status остаются на owner node

### Process band

- живёт между owner и tasks
- имеет фиксированную высоту
- резервируется всегда, даже если сейчас process не отображается
- это сознательный tradeoff ради стабильности

### Task band

- расположен внизу slot
- имеет фиксированную высоту `5 rows`
- содержит все активные non-empty kanban columns
- каждая колонка рендерится внутри общей высоты band
- если task-ов сейчас нет, band остаётся пустым визуально, но не схлопывается геометрически

## Поведение task overflow

Так как мы сохраняем multi-column kanban, overflow нужно трактовать строго.

### Правило

Для каждой колонки отдельно:

- если задач `<= 5`, показываются реальные tasks
- если задач `> 5`, показывается:
  - `4` реальных tasks
  - `1` overflow stack в последнем row

### Что это даёт

- высота slot стабильна
- все columns видимы
- overflow честно обозначен
- не нужен scroll

### Порядок задач внутри колонки

Этот refactor **не меняет** текущую каноническую задачу порядка внутри колонки.

Значит:

- если сейчас в колонке есть уже существующий deterministic order, его сохраняем
- stable slot layout не должен попутно вводить новый sort по времени, title или id
- overflow stack строится поверх уже существующего column order

## Поведение activity overflow

Для activity lane:

- показываем `3` реальных items
- потом показываем `+N more`
- `+N more` открывает профиль участника на вкладке `Activity`

Внутри профиля участника уже должны продолжать работать:

- `All`
- `Messages`
- `Comments`

Это не часть новой layout-логики, но поведение нельзя потерять.

## Activity item semantics

### Messages

- переиспользуют существующий compact message widget
- клики и hover-поведение должны остаться совместимыми с уже существующим UI
- reuse boundary здесь - существующий visual/component behavior, а не обязательная привязка к текущему screen-space positioning path

### Comments

- в visual target показывают `task display id`
- не маскируются под message между двумя участниками
- должны явно читаться как `comment on task`

### Ordering

- в slot: newest first
- в полном activity tab: текущий существующий порядок не должен деградировать

### Tie-break для activity ordering

Чтобы `newest first` не реализовали по-разному в двух местах, фиксируем:

1. сначала сортируем по `timestamp desc`
2. если timestamps совпали, используем стабильный secondary key:
   - existing source order, если он уже есть в данных
   - иначе `id`

Это нужно, чтобы activity lane не дрожала при одинаковых timestamps и повторных rebuild-ах.

## Process semantics

Для `v1` process rail показывает **один самый релевантный process**:

1. сначала running process
2. если running нет, последний недавно завершённый visible process
3. если релевантного process нет, band остаётся пустым, но место под него остаётся зарезервированным

## Lead-specific geometry

Lead обрабатывается отдельно.

### Lead central exclusion включает

- сам `lead node`
- `launch HUD`
- `lead activity band`
- минимальный safety padding вокруг этого блока

`launch HUD` reserved zone должна сохраняться анти-jump образом, даже если compact HUD сейчас скрыт или dismissed. Для planner-а это persistent часть central exclusion.

### Важный инвариант

Ни один member slot не должен строиться так, будто этих central zones не существует.

Иначе первый ring снова залезет в центр.

### Recommended central block anatomy

Чтобы `lead central reserved block` не трактовали по-разному в разных местах, фиксируем рекомендованную структуру:

1. `lead activity frame` слева
2. `lead core frame` по центру
3. `launch HUD frame` справа

Где:

- `lead activity frame` использует те же bounded rules, что и member activity lane
- `lead core frame` содержит сам `lead node` и минимальную label/status area
- `launch HUD frame` резервируется даже если compact HUD сейчас hidden/dismissed

Итоговый `leadCentralReservedBlock` считается как union этих трёх частей плюс обязательные внутренние gap-ы и внешний safety padding.

### Что важно для v1

- `lead activity frame` не схлопывается только потому, что сейчас у lead мало activity
- `launch HUD frame` не схлопывается только потому, что compact HUD сейчас не показан
- member planner не знает про внутренние части central block-а по отдельности, он видит уже собранный итоговый `leadCentralReservedBlock`

Это нужно, чтобы центр оставался стабильным и не пересобирался от мелких UI-состояний.

## Stable identity - обязательная часть

Это самая критичная инфраструктурная часть плана.

Без неё slot assignment будет хрупким и будет ломаться при rename и refresh.

### Что меняем

`ResolvedTeamMember` должен получить:

```ts
agentId?: string;
```

### Правило stable owner id

```ts
stableOwnerId = member.agentId ?? member.name
```

### Правило node id

Member node id в графе должен строиться на `stableOwnerId`, а не на display name.

То есть вместо старой name-based схемы нужен stable id path:

```ts
memberNodeId = `member:${teamName}:${stableOwnerId}`
```

Display label при этом остаётся `member.name`.

### Где stableOwnerId обязателен

- member node id
- task.ownerId reference
- process ownership
- activity ownership
- slot assignment storage
- drag/snap
- ordering

### Где name можно оставить только как display field

- label на node
- human-readable popover title
- callbacks, где UI дальше открывает профиль по имени

## Visibility / removed member policy

Чтобы новый layout не начал внезапно показывать другой состав owners, фиксируем:

- этот refactor не переопределяет сам по себе graph visibility policy для removed members
- если removed member сейчас не должен быть owner node в графе, он не получает slot
- если задача ссылается на owner, которого нет в текущем visible owner set, такая задача должна попадать в `unassigned task slot`, а не ломать planner

### Важное уточнение

`visible owner set` для planner-а строится из owner/node visibility policy, а не из presentation filters вида:

- `showTasks`
- `showProcesses`
- `showEdges`

То есть filters не должны внезапно менять состав member owners, которых planner пытается раскладывать.

## Stable ordering - обязательное правило

Initial placement должен быть детерминированным.

Фиксируем такой порядок:

1. Сначала уже сохранённые `slot assignments`
2. Затем `teamData.config.members[]`, сматченные по `stableOwnerId`
3. Затем owners, которых нет в config order
4. Final tie-break - `stableOwnerId`

Это важно, чтобы:

- layout не дёргался при refresh
- порядок был связан с конфигом команды
- ordering не ломался при rename

## Owner set resolution - before planner

Чтобы planner не собирал layout actors "по пути" из разных источников, фиксируем один этап до планирования.

### До запуска planner-а должен быть построен

- `lead central reserved block`
- ordered visible member owners
- условный `unassigned task slot`, если он нужен

### Чего там быть не должно

- tasks как самостоятельных owners
- process nodes как самостоятельных owners
- activity items как самостоятельных owners
- зависимостей от hover, selection, unread highlight или camera state

То есть сначала строим **layout actors set**, и только потом планируем геометрию.

## Source of truth by concern

Чтобы в коде не появилось несколько "почти главных" источников истины, фиксируем это явно.

### Identity

- source of truth: `stableOwnerId = agentId ?? member.name`

### Owner placement

- source of truth для **member sector slots**: `slotAssignmentsByTeam[teamName][stableOwnerId]`
- `lead central reserved block` не хранится в `slotAssignmentsByTeam`
- `unassigned task slot` не хранится в `slotAssignmentsByTeam` и строится derivation-логикой от текущего dataset

### Geometry

- source of truth: planner helpers, которые из assignments и footprints строят `SlotFrame`

### Active render geometry

- source of truth: последний **валидный и текущий** `StableSlotLayoutSnapshot`, собранный из текущих inputs
- invalid candidate snapshot не становится active render geometry
- stale snapshot cache не должен подменять current render geometry, если для текущего pass активирован fallback path

### Activity data

- source of truth: существующий messages/comments data path
- activity lane не строится из particles и не строится из transient overlay state

### Task ordering

- source of truth: текущая каноническая kanban/column order semantics
- этот refactor её не переизобретает

### Process selection

- source of truth: текущий process data path
- новый layout меняет positioning, а не выдумывает новый параллельный источник process state

## Runtime precedence matrix

Чтобы во время интеграции не появилось несколько конкурирующих "почти верных" состояний, фиксируем runtime precedence явно.

### 1. Placement identity precedence

Для `member sector slots` порядок такой:

1. `slotAssignmentsByTeam[teamName][stableOwnerId]`
2. planner default placement для owner без assignment

Больше никаких placement identity sources у `v1` нет.

### 2. Geometry build precedence

Для текущего render-pass порядок такой:

1. текущие inputs
2. current assignments
3. planner builds candidate snapshot
4. validator либо подтверждает snapshot, либо отклоняет его

То есть geometry нельзя брать:

- из старого DOM layout
- из raw pinning
- из screen-space overlay коррекций

### 3. Active render precedence

Для renderer порядок такой:

1. если есть валидный current snapshot для этого pass - рендерим его
2. если current snapshot invalid - не делаем его active render geometry
3. если текущий path в `no-lead fallback`, рендерим fallback presentation path
4. session-local last valid snapshot cache не становится active render geometry автоматически

### 4. Persistence precedence

Для store/state:

1. валидный committed assignment update пишет `slotAssignmentsByTeam`
2. invalid candidate geometry ничего не пишет в assignments
3. snapshot cache не пишет assignments сам по себе

### Ключевая мысль

`slotAssignmentsByTeam` отвечает за identity placement, `StableSlotLayoutSnapshot` отвечает за валидную текущую geometry-картину, fallback path отвечает за безопасный transient rendering, и эти роли нельзя смешивать.

## Где хранить slot assignment

Источник истины для slot placement должен жить **в renderer-side team UI state**, а не в graph package.

Graph package должен получать уже готовые assignments / placement inputs.

Нормативная структура `v1`:

```ts
type OwnerSlotAssignment = {
  ownerStableId: string;
  ringIndex: number;
  sectorIndex: number;
};

type TeamSlotAssignments = Record<string, OwnerSlotAssignment>;
type TeamSlotAssignmentsByTeam = Record<string, TeamSlotAssignments>;
```

Где key верхнего уровня - `teamName`.

### Почему верхний key именно `teamName` в `v1`

Текущий team data / IPC / graph integration path в проекте в основном уже team-scoped через `teamName`.

Поэтому для `v1` фиксируем:

- layout state scoped по `teamName`
- team switch просто переключает текущий scoped layout state
- assignments одной команды не должны протекать в другую

Если в будущем появится first-class stable `teamId`, это может стать отдельным улучшением, но не является обязательной частью этого refactor.

### Что это значит для team rename

Так как в `v1` верхний key именно `teamName`, фиксируем явный tradeoff:

- если меняется именно storage identity команды, то layout state для неё считается новым scoped state
- автоматическая миграция layout state между старым и новым `teamName` в этот refactor не входит

Важно не путать это с:

- rename участника при том же `agentId`
- display-only label change, которая не меняет team storage key

### Что именно хранится здесь

Только assignments для **draggable member sector slots**.

Здесь **не** храним:

- `lead central reserved block`
- `launch HUD`
- `lead activity`
- `unassigned task slot`

Они должны строиться derivation-логикой, а не жить как псевдо-persisted assignments.

### Что важно

- Не хранить здесь raw `x/y`
- Не смешивать это с existing pinning model
- Если в коде уже есть pinned positions, для owner layout их нужно:
  - либо мигрировать в ближайший slot один раз
  - либо игнорировать для lead/member и постепенно удалить owner-specific path

## Snapshot lifecycle and precedence

Это отдельный обязательный contract, чтобы renderer не оказался между "старой" и "новой" геометрией.

### Normal path

Если inputs валидны и planner собрал валидный snapshot:

1. собираем новый `StableSlotLayoutSnapshot`
2. валидируем его
3. делаем его active render geometry
4. обновляем session-local last valid snapshot cache

### Validation failure path

Если inputs есть, но candidate snapshot невалиден:

1. candidate snapshot не коммитится
2. active render geometry не обновляется этим candidate snapshot
3. `slotAssignmentsByTeam` не перезаписывается частично
4. session-local last valid snapshot cache остаётся прежним
5. пишется diagnostic warning

### No-lead path

Если текущий dataset не содержит `lead`:

1. stable-slot planner path не строит новый snapshot
2. active render geometry для stable-slot path не обновляется
3. session-local last valid snapshot cache не очищается автоматически
4. renderer для этого pass использует fallback presentation path, а не stale stable-slot snapshot как активную картинку

### Главное различие

- last valid snapshot cache нужен для safety и continuity логики
- active render geometry должна соответствовать текущему валидному render path

Нельзя подменять второе первым.

### Persistence scope для v1

Для первой реализации достаточно renderer-side persistence в team UI state.

В этом pass **не нужно**:

- писать slot assignments в team config
- тащить их через main process
- делать cross-session durable migration как обязательную часть layout refactor

Сначала нужен стабильный рабочий layout внутри текущего renderer state path.

### Legacy pin migration policy

Чтобы не оставлять это на усмотрение implementer-а, фиксируем стартовую политику:

- для `lead/member` legacy raw pinned positions в новом режиме **не являются** источником истины
- если такие данные существуют, на первом входе в `stable-slots-v1` их нужно один раз:
  - сматчить в ближайший валидный slot assignment
  - после этого дальше жить уже только через slot assignment

Не нужно бесконечно поддерживать два параллельных источника истины:

- raw owner pinning
- slot assignment

### Migration from fallback name to agentId

Это отдельный переходный случай, который нельзя оставлять "как-нибудь само".

Сценарий:

- раньше member жил на fallback key `member.name`
- позже для него стал доступен `agentId`

Для `v1` фиксируем такое правило:

- если у текущего visible member появился `agentId`
- и assignment под новым `stableOwnerId` ещё не существует
- но есть старый assignment под его прежним fallback `member.name`

то этот assignment нужно **один раз** перенести на новый `stableOwnerId` до запуска planner-а.

Это нужно, чтобы член команды не "терял место" только потому, что identity стала более качественной.

### Migration precedence - чтобы не было двойной трактовки

Порядок для `v1` фиксируем такой:

1. если `slotLayoutVersion` не совпадает - старые member assignments сбрасываем целиком
2. если version совпадает и assignment уже есть под новым `stableOwnerId` - используем его как source of truth
3. если assignment под новым `stableOwnerId` ещё нет, но есть старый assignment под fallback `member.name` - переносим его один раз
4. если существуют и старый fallback assignment, и новый stable assignment одновременно - побеждает новый stable assignment, fallback alias удаляется

Это правило нужно, чтобы миграция не создавала две конкурирующие записи для одного и того же member-а.

## Slot frame model

Для planner-а нужен явный rectangular model.

Нормативная внутренняя структура `v1`:

```ts
type SlotFrame = {
  ownerStableId: string;
  ringIndex: number;
  sectorIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
```

`x/y` здесь - top-left slot frame в world coordinates.

### Важное уточнение

`SlotFrame` в этом документе означает именно frame для **member sector slot**.

Для special geometry используем отдельные понятия:

- `lead central reserved block`
- `UnassignedTaskSlotFrame`

Они могут быть AABB-похожими по форме, но не должны участвовать как обычные member slot assignments.

### Почему прямоугольник, а не только radius

Потому что пользовательская проблема именно в прямоугольных зонах:

- activity cards
- process rail
- task columns

Значит planner должен работать не только с радиусом, а с **реальными AABB bounds**.

## World-space geometry contract

Это один из самых критичных пунктов плана, потому что прошлые баги были именно из-за смешивания world-space и screen-space.

### Обязательное правило

- planner, slot frames и local anchors живут в `world coordinates`
- camera zoom/pan применяется только как визуальный transform поверх уже готовой world geometry
- `GraphActivityHud` и похожие UI-слои не должны повторно "спасать" layout через screen-space repositioning

### Что запрещено

- post-render screen-space packing соседних owners
- DOM-based reflow logic, которая двигает slot zones независимо от planner-а
- вычисление layout из текущего zoom level

Если какой-то элемент выглядит налезающим, исправлять нужно planner / footprint / slot bounds, а не screen-space коррекцией.

## Owner anchor inside slot

Чтобы implementer не трактовал slot как угодно, фиксируем owner anchor rule.

### Правило

- `(ringIndex, sectorIndex)` сначала определяют `ownerAnchor` на соответствующем sector ray
- `slot frame` задаёт outer bounds всей owner-local зоны
- `slot frame` строится вокруг `ownerAnchor`, а не выбирается произвольно постфактум
- сам `member node` располагается по горизонтальному центру slot
- по вертикали `member node` располагается в `owner band`, между `activity band` и `process band`
- `activity band` всегда выше owner node
- `task band` всегда ниже owner node

### Каноническая формула для `SlotFrame`

Чтобы не было двух разных трактовок top-left координаты, фиксируем canonical build rule:

```ts
slotFrame.x = ownerAnchor.x - slotWidth / 2
slotFrame.y = ownerAnchor.y - (activityBandHeight + ownerBandHeight / 2)
slotFrame.width = slotWidth
slotFrame.height = slotHeight
```

То есть:

- `ownerAnchor.x` всегда совпадает с horizontal centerline slot-а
- `ownerAnchor.y` всегда совпадает с вертикальным центром `owner band`
- верхняя граница slot-а определяется от activity band, а не "как получится"

Это делает geometry детерминированной и одинаковой для planner-а, hit testing и renderer-а.

### Канонические локальные origins

Локальные точки считаем только от `slotFrame`, а не от DOM/layout side effects:

```ts
activityOrigin = {
  x: slotFrame.x,
  y: slotFrame.y,
}

ownerBandOrigin = {
  x: slotFrame.x,
  y: slotFrame.y + activityBandHeight,
}

processOrigin = {
  x: slotFrame.x,
  y: slotFrame.y + activityBandHeight + ownerBandHeight,
}

taskOrigin = {
  x: slotFrame.x,
  y: slotFrame.y + activityBandHeight + ownerBandHeight + processBandHeight,
}
```

Если какой-то renderer-pathу нужен другой anchor, он должен вычисляться как производный от этих канонических origins, а не как отдельная независимая правда.

### Практически

Нужен один helper уровня domain/layout, который из `SlotFrame` возвращает локальные anchor points:

- `ownerAnchor`
- `activityOrigin`
- `processOrigin`
- `taskOrigin`

UI и canvas не должны заново высчитывать эти точки каждый по-своему.

## Owner footprint contract

`OwnerFootprint` должен считаться детерминированно из layout rules и данных, а не из уже отрендеренного DOM.

### В `OwnerFootprint` входят

- итоговый `slotWidth`
- итоговый `slotHeight`
- bucket `S / M / L`
- optional flags, влияющие на layout validity:
  - есть ли `activity items`
  - есть ли релевантный `process`

### Важно

- `OwnerFootprint` считается до рендера
- он должен быть pure и testable
- разные React paths не должны считать footprint по-разному

## Slot orientation rule

Чтобы не возникло двух разных реализаций "stable sectors", фиксируем это явно:

- slot contents **не ротируются** по углу сектора
- text и UI внутри slot всегда остаются upright
- `Activity / Member / Process / Tasks` всегда идут в одном и том же вертикальном порядке сверху вниз

То есть sector влияет на положение slot вокруг lead, но не на внутреннюю ориентацию карточек и текста.

## Horizontal alignment inside slot

Чтобы band-ы не выравнивались хаотично по-разному, фиксируем правило:

- у slot есть общий горизонтальный centerline
- `member node` центрируется по этой линии
- `activity band` центрируется по этой линии
- `process rail` центрируется по этой линии
- `task band` центрируется по этой линии

Если у band своя фактическая ширина меньше `slotWidth`, он не липнет к левому краю slot, а центрируется внутри slot frame.

## Slot width rules

`slotWidth` считается честно, от контента.

### Формула

```ts
slotWidth = max(
  activityWidth,
  ownerMinWidth,
  processRailWidth,
  kanbanWidth
)
```

### Где

- `activityWidth` - ширина compact activity lane
- `ownerMinWidth` - минимальная ширина под owner node + label area
- `processRailWidth` - ширина attached process rail
- `kanbanWidth` - суммарная ширина всех активных columns с gutter-ами

### Важно

- bucket не определяет итоговую ширину
- bucket только классифицирует уже посчитанную ширину

### Что влияет на slot width

- число `active non-empty` kanban columns
- фиксированная ширина compact activity lane
- фиксированная ширина process rail
- минимальная owner label area

### Что не должно влиять на slot width

- случайная длина message preview текста
- случайная длина task subject, если pill уже имеет фиксированную ширину и truncation
- unread badge count
- hover / selection state

Иными словами: slot width должен расти из-за реальной структурной ширины owner-local зон, а не из-за случайного текстового контента.

## Slot height rules

`slotHeight` bounded и предсказуем.

### Формула

```ts
slotHeight =
  activityBandHeight +
  ownerBandHeight +
  processBandHeight +
  taskBandHeight +
  verticalGaps
```

### Важно

- activity band height фиксирован
- process band height фиксирован
- task band height фиксирован (`5 rows`)
- значит рост задач меняет в первую очередь `slotWidth`, а не `slotHeight`

Это ключевой выбор ради стабильности.

## Width buckets - как трактовать правильно

`S / M / L` нужны planner-у как packing heuristic, но не как UI limit.

### Правильное правило

1. Сначала считаем **реальный** `slotWidth`
2. Потом присваиваем bucket
3. Потом planner использует bucket и точный width

### Что не делаем

- не считаем bucket по display name
- не считаем bucket только по числу задач
- не используем bucket как замену реальной ширины

### Стартовая bucket policy для v1

Чтобы первая реализация не разошлась в трактовках, фиксируем стартовое правило:

- `S` - `1` active non-empty kanban column
- `M` - `2-3` active non-empty kanban columns
- `L` - `4+` active non-empty kanban columns

Если `activityWidth` или `processRailWidth` делает slot шире ожидаемого bucket-а, planner всё равно должен опираться на **реальный `slotWidth`**, а bucket использовать только как coarse hint.

## Геометрические defaults для v1

Чтобы implementer не подбирал layout "на глаз" каждый по-своему, фиксируем стартовые значения:

- `slotVerticalGap = 24`
- `slotHorizontalGap = 32`
- `ringGap = 140`
- `centralSafetyPadding = 48`
- `memberSlotInnerPadding = 16`

Это именно стартовые defaults. Их можно тюнить, но они должны жить в одном месте и изменяться осознанно, а не расползаться по коду.

### Source of geometry constants

Все такие значения должны жить в одном domain-level constants module для stable-slot layout.

Нельзя:

- дублировать их отдельно в planner
- отдельно в renderer
- отдельно в hit testing
- отдельно в fit helpers

Иначе визуально одинаковый slot начнёт иметь разные размеры в разных частях системы.

## Ring radius rule

Радиус следующего ring нельзя считать "по ощущению".

Для `v1` фиксируем стартовое правило:

```ts
nextRingRadius =
  previousRingRadius +
  maxSlotDepthOnPreviousRing +
  ringGap
```

Где `maxSlotDepthOnPreviousRing` - максимальный размер slot по радиальному направлению среди owners этого ring.

## Ring planner - строгая логика

Planner должен быть детерминированным и минимально разрушительным.

### Что именно planner планирует

Этот planner планирует только **member sector slots**.

Он не должен пытаться раскладывать:

- `lead central reserved block`
- `launch HUD`
- `lead activity`
- `unassigned task slot`

Эти части должны быть построены заранее как fixed/special geometry, влияющая на exclusion и bounds.

### Inputs

- central exclusion bounds
- ordered visible member owners
- saved slot assignments
- slot footprints
- ring / sector constants

### Output

- `SlotFrame[]` для member sector slots

### Базовый алгоритм

```ts
for owner in orderedOwners:
  if savedAssignment(owner) still valid:
    keep it
    reserve frame
    continue

  place owner into first valid candidate:
    by preferred ring
    then by preferred sector
    then by next available ring/sector
    where candidate frame:
      does not intersect central exclusion
      does not intersect occupied slot frames
      respects min gap
```

### Правило минимального разрушения

Если owner уже был привязан к сектору, planner должен сначала попытаться:

1. оставить тот же `sectorIndex`
2. если не помещается - оставить тот же сектор, но увести owner на внешний ring
3. только потом искать новый сектор

Это даёт более стабильное поведение, чем немедленный полный reshuffle по всем секторам.

### Порядок выбора candidate slots

Чтобы planner не получился "похожим, но разным" в двух местах кода, фиксируем порядок выбора явно.

#### Для owner с уже существующим assignment

1. тот же `(ringIndex, sectorIndex)`, если он всё ещё valid
2. тот же `sectorIndex` на следующем внешнем ring
3. ближайшие соседние sectors на том же ring
4. ближайшие соседние sectors на внешних rings

#### Для нового owner без assignment

1. ring 1, sectors в фиксированном canonical order
2. если ничего не влезло - ring 2, тот же canonical order
3. и так далее

#### Canonical sector order для planner-а

Используем тот же порядок, что уже зафиксирован выше:

1. `top`
2. `upper-right`
3. `lower-right`
4. `bottom`
5. `lower-left`
6. `upper-left`

Это правило важно, чтобы initial placement, replanning и drag-target selection не расходились между собой.

### Что значит nearest valid slot при drag

Чтобы drag/snap не реализовали двумя разными способами, фиксируем:

- nearest candidate считается по расстоянию от текущего dragged `ownerAnchor` до candidate `ownerAnchor`
- metric - обычное Euclidean distance в world coordinates
- если расстояние одинаковое, tie-break идёт по canonical sector order

Это даёт детерминированное поведение и не зависит от текущего zoom/pan.

### Что значит "still valid"

Saved assignment считается valid, если:

- slot frame для него можно построить
- frame не пересекает central exclusion
- frame не пересекает уже занятые slot frames
- current owner footprint всё ещё помещается

Если assignment invalid, owner перепланируется, но **не весь layout с нуля**, а только конфликтующие части.

## Reflow policy - когда planner имеет право перестраивать схему

Чтобы не было хаотических reshuffle, вводим чёткое правило.

### Layout нельзя перестраивать полностью из-за

- новых activity items
- комментариев
- изменения unread badges
- process content update без роста footprint
- zoom / pan
- rename при том же `agentId`

### Layout может перестраивать часть owners из-за

- появления нового owner
- удаления owner
- drag/swap
- роста slot footprint, который делает current assignment invalid
- появления `unassigned task slot`, если он расширил lower central exclusion и создал реальный конфликт
- исчезновения `unassigned task slot`, только если пользователь явно сделал `reset layout`

### Предпочтительный принцип

`keep existing placements whenever still valid`

Это обязательный инвариант для стабильности.

## Post-plan validation and fail-closed behavior

Даже хороший planner иногда можно сломать интеграцией. Поэтому после каждого planner run нужна отдельная deterministic validation pass.

### Нужен отдельный pure helper

Рекомендуемая форма:

```ts
validateStableSlotLayout({
  slotFrames,
  runtimeCentralExclusion,
  ownerFootprints,
  assignments,
})
```

### Validator обязан проверять

- все `SlotFrame` конечные и не содержат `NaN/Infinity`
- нет двух owners с одним и тем же assignment
- ни один `member sector slot` не пересекает `runtimeCentralExclusion`
- `member sector slots` не пересекаются между собой
- полный frame slot-а включает `Activity`, `Owner`, `Process` и `Task` bands
- локальные anchors лежат внутри своего `SlotFrame`
- итоговые fit bounds конечные и ненулевые

### Fail-closed правило

Если validation не прошла:

- не рендерим "полусломанный" новый layout как будто он валиден
- оставляем предыдущий последний валидный layout snapshot для этой команды, если он есть
- если валидного snapshot нет, используем безопасный fallback без persistent overwrite
- пишем diagnostic warning в лог, чтобы баг можно было воспроизвести

### Что нельзя делать при validation failure

- silently чинить layout screen-space коррекцией
- частично коммитить невалидные assignments в store
- двигать только Activity/Process/Tasks отдельно от slot frame, пытаясь "спасти картинку"

Это критично: broken layout должен ломаться явно и безопасно, а не превращаться в новый источник хаоса.

## Conflict resolution order - when one slot stops fitting

Это один из самых важных практических пунктов. Именно здесь чаще всего implementer случайно делает hidden global reshuffle.

### Если один owner стал невалиден из-за роста footprint

Planner должен идти по такому порядку:

1. сохранить все unaffected owners на месте
2. попробовать оставить problem owner в том же `sectorIndex`, но увести на следующий outer ring
3. если этого недостаточно, попробовать минимальный локальный spill конфликтующего подмножества owners
4. не делать полный global reshuffle, если пользователь явно не вызвал `reset layout`

### Что считается preferred behavior

- cheapest valid local fix wins
- количество затронутых owners должно быть минимальным
- owner, который инициировал конфликт ростом footprint, должен двигаться первым, если это решает проблему

Это правило важно, чтобы граф оставался предсказуемым и не "переезжал весь" из-за одной widened kanban zone.

## Canonical layout build pipeline

Чтобы новый path не был реализован в разных местах по-разному, фиксируем канонический порядок сборки layout.

### Шаги

1. Построить visible graph dataset
2. Разрешить `stableOwnerId` для members
3. Построить `lead central reserved block`
4. Если есть unassigned tasks - построить `unassigned task slot`
5. Из пунктов `3-4` собрать итоговый `central exclusion`
6. Построить ordered visible member owners
7. Для каждого member owner посчитать `OwnerFootprint`
8. Запустить member slot planner
9. Получить `SlotFrame[]` для member slots
10. Из `SlotFrame` построить local anchors:
    - `ownerAnchor`
    - `activityOrigin`
    - `processOrigin`
    - `taskOrigin`
11. Собрать цельный `StableSlotLayoutSnapshot`
12. Прогнать validation на полном snapshot
13. Только после этого передать world-space geometry в renderer / graph package
14. Только после этого применять camera zoom/pan

### Что нельзя делать

- сначала отрендерить Activity/Tasks, а потом ими "уточнить" layout
- сначала запустить screen-space pack, а потом пытаться сохранить это как source of truth
- считать planner output неполным и дозаполнять его DOM-side reposition логикой

## Atomic layout transaction rule

Это важный anti-bug contract. Layout update должен коммититься как одна транзакция, а не серией мелких частичных записей.

### Правило

Один graph update делает только такой путь:

1. derive inputs
2. build full snapshot
3. validate snapshot
4. commit whole snapshot
5. render from committed snapshot

### Что запрещено

- сначала записать новые assignments, а `SlotFrame` пересчитать позже
- сначала обновить `memberSlotFrames`, а `fitBounds` и `runtimeCentralExclusion` дотянуть в следующем tick
- отдельно коммитить `Activity` geometry и отдельно `Task` geometry
- держать в renderer одновременно старые `fitBounds` и новые `SlotFrame`

### Почему это обязательно

Большая часть "странных" overlap и jump-багов рождается не из формулы planner-а, а из того, что разные части UI в течение одного render-cycle смотрят на разные поколения layout state.

Новый path должен быть transaction-like: либо весь snapshot валиден и коммитнут, либо остаётся предыдущий валидный snapshot.

## Debug / observability requirements

Этот refactor слишком геометрический, чтобы оставлять отладку на `console.log` по месту.

### Минимум, который нужен в `v1`

- dev-only возможность вывести для owner:
  - `stableOwnerId`
  - `ringIndex`
  - `sectorIndex`
  - `slotWidth`
  - `slotHeight`
  - bucket `S/M/L`
- dev-only warning при validation failure с причиной
- dev-only возможность понять, какой owner был локально перепланирован и почему

### Чего не нужно делать

- тащить это в публичный product UI
- делать отдельный user-facing debug mode

Это purely implementation aid, но он сильно снижает риск, что спорные overlap-cases будут разбираться "на глаз".

## View modes - tab and fullscreen

Новый layout не должен иметь две разные правды для разных способов открытия графа.

### Правило

- graph tab и fullscreen overlay используют один и тот же `slotAssignmentsByTeam`
- graph tab и fullscreen overlay используют один и тот же `slotLayoutVersion`
- открытие fullscreen не должно заново seed-ить owner placement
- drag в одном режиме должен сразу отражаться в другом режиме
- camera state при этом может быть разным и не обязан шариться между режимами

Иными словами: разные view modes - это разные камеры и контейнеры, но не разные layout models.

## Team switch behavior

Layout state должен быть жёстко team-scoped.

### Правило

- переключение на другую команду читает только её `slotAssignmentsByTeam[teamName]`
- возврат назад использует ранее сохранённый scoped layout этой команды
- assignments и camera state одной команды не должны случайно применяться к другой
- если одна и та же команда открыта в нескольких pane-ах, layout state у неё общий
- при конкурентном обновлении layout state для одной команды действует обычное shared-state правило `last write wins`

Это особенно важно для случаев, когда несколько graph tabs / panes открыты параллельно.

## Hidden member -> reappear behavior

Это полезно зафиксировать отдельно, чтобы реализация не делала лишний churn layout-а.

### Правило

- если member временно исчез из `visible owner set`, его slot не участвует в текущем planner run
- при этом его сохранённый member assignment может оставаться в `slotAssignmentsByTeam`
- если тот же member потом возвращается с тем же `stableOwnerId`, planner сначала пытается переиспользовать прежний assignment
- если прежний assignment больше не валиден, только тогда делается локальный replanning

Это даёт более стабильное поведение, чем каждый раз забывать slot при любом временном исчезновении owner-а.

## Graph filters - влияние на layout

Это место обязательно нужно зафиксировать, иначе после рефактора легко вернуть layout jumps через UI toggles.

### Для `v1` правило такое

- `showTasks`
- `showProcesses`
- `showEdges`

не являются входом для planner-а и не должны менять slot assignments.

### Что они делают

- `showTasks = false` скрывает task rendering, но не перестраивает member slots и не уничтожает reserved task band geometry
- `showProcesses = false` скрывает process rail rendering, но не перестраивает member slots и не убирает reserved process band geometry
- `showEdges = false` влияет только на edges

### Отдельно про `unassigned task slot`

Так как это special slot, состоящий только из task band-а, фиксируем отдельно:

- если в dataset есть unassigned tasks, сам `unassigned task slot` продолжает учитываться в topology
- `showTasks = false` может скрыть его presentation, но не должен убирать его reserved topology footprint
- исчезновение `unassigned task slot` как layout actor происходит только когда unassigned tasks реально исчезли из dataset, а не из-за UI filter toggle

Это осознанный tradeoff ради стабильности. Filters в `v1` скрывают presentation, а не перестраивают топологию layout.

## No-lead fallback

Stable sector planner в этом плане опирается на наличие `lead`.

### Для `v1` фиксируем точное поведение

- если в текущем visible dataset временно нет `lead`
- новый stable-slot planner не должен пытаться строить сектора "вокруг пустоты"
- новый `StableSlotLayoutSnapshot` в таком состоянии не строится и не коммитится
- persistent assignments не перезаписываются
- если для этой команды уже есть последний валидный stable-slot snapshot текущей сессии, он остаётся последним валидным snapshot и не заменяется случайной геометрией
- если валидного snapshot ещё не было, stable-slot presentation path для этого render-pass не активируется до возвращения lead

### Чего нельзя делать

- сохранять случайные placements как будто это валидный stable layout
- создавать fake lead только ради того, чтобы planner "отработал"

Это transient safety rule, чтобы неполные данные не портили persistent layout state.

## Drag and snap semantics

Drag нужен, но он не должен возвращать нас к свободной физике.

### Правила

- Drag доступен только для `member slots`
- `lead` не draggable
- Во время drag можно подсвечивать ближайший candidate slot
- При drop owner снапается в nearest valid slot
- Если target занят:
  - делаем `swap`
  - не делаем overlap
  - не делаем silent fallback в произвольную соседнюю точку

### Что сохраняем после drop

Только:

- `ringIndex`
- `sectorIndex`

Не сохраняем:

- абсолютные координаты

### Важное уточнение про swap

Swap допустим только если обе итоговые позиции валидны после обмена.

Если ближайший занятый slot приводит к невалидной паре placement-ов, нужно брать следующий nearest valid candidate, а не насильно выполнять swap.

### Поведение при drop вне валидного target

Если пользователь отпускает owner там, где нет валидного slot candidate:

- owner возвращается в свой предыдущий assignment
- промежуточная невалидная world position не сохраняется

Это обязательно, чтобы drag не оставлял граф в полусломанном состоянии.

## Почему swap выбран по умолчанию

Потому что это самое понятное поведение для пользователя:

- место уже занято
- я кладу owner туда
- значит владельцы меняются местами

Любая "умная" скрытая перестановка менее предсказуема.

## Activity connector - как трактовать

Connector нужен, но он должен быть локальным и cheap.

### Правило

- connector рисуется между activity band и owner band внутри одного slot
- connector не участвует в глобальном packing
- connector не должен тянуться через пол-графа

Это просто визуальная связь, а не самостоятельный layout actor.

## Process rendering - важное уточнение

Для `v1` безопаснее **не выкидывать process nodes из графовой модели полностью**.

Лучший путь:

- оставить process data в graph domain
- но перестать раскладывать process nodes как независимые свободные entities
- вместо этого позиционировать process presentation внутри owner slot

То есть меняем **геометрию и ownership**, а не обязательно весь data contract в один проход.

## Activity rendering - важное уточнение

`GraphActivityHud` в новой модели не должен сам быть planner-ом.

Его роль после переделки:

- взять уже посчитанные slot-local coordinates
- отрендерить compact activity UI
- отрендерить локальный connector

Чего он делать больше не должен:

- сам pack-ить owner lanes друг относительно друга
- сам спасать cross-owner overlap
- сам решать world geometry

## Zoom / pan / fit - обязательные инварианты

### Zoom и pan

Zoom и pan должны менять только camera transform.

Они не имеют права:

- перераскладывать slots
- менять relative positions внутри slot
- менять размер slot в screen-space независимо от world model

### Fit

`zoomToFit` и initial fit обязаны учитывать:

- member slot frames
- lead central exclusion
- launch HUD
- unassigned task slot
- activity bands
- task bands
- process rails

Не только центры owner nodes.

### Важное уточнение про filters

Даже если `showTasks = false` или `showProcesses = false`, fit в `v1` должен учитывать **reserved topology bounds**, а не только текущие видимые DOM/canvas элементы.

Иначе переключение filters снова будет вызывать визуальный jump layout-а и нарушит главный инвариант стабильности.

## Member add/remove behavior

### Add

- existing valid assignments сохраняются
- новый owner получает первый валидный slot по planner rules
- если ring 1 full по footprint, новый owner идёт в ring 2

### Remove

- slot освобождается
- остальные owners не auto-compact-ятся только из-за самого факта remove/hide

Фиксируем правило:

- без explicit reset-layout не делаем агрессивный global compaction

Это уменьшает визуальные скачки.

### Reset layout behavior

Нужен явный reset path:

- очистить `slotAssignmentsByTeam[teamName]`
- заново построить placements по planner rules

Это нужно и для пользователя, и для отладки, и для быстрого выхода из редких неудачных layout-состояний.

## Rename behavior

Если:

- `agentId` тот же
- изменился только `member.name`

то layout обязан сохранить:

- slot assignment
- drag placement
- activity ownership
- process ownership
- task ownership references

Если `agentId` нет и используется fallback на имя, это known-weaker mode, и это нужно явно покрыть тестом.

## Поведение при росте задач

Это отдельный важный edge case, который уже обсуждался.

### Сценарий

У owner сначала мало задач, потом их становится много.

### Что не делаем

- не включаем scroll внутри slot
- не скрываем часть columns
- не даём tasks раздавить activity соседнего owner

### Что делаем

- task band остаётся высотой `5 rows`
- все active non-empty columns продолжают показываться
- slot width растёт
- если текущий ring больше не вмещает выросший slot, owner может уйти на более дальний ring

### Ключевой инвариант

Даже если owner уходит во внешний ring, это должно быть:

- детерминированно
- минимально разрушительно
- без общего хаотичного reshuffle

## Public / shared contract changes

Ниже то, что нужно явно зафиксировать, чтобы не появлялись "невидимые" зависимости.

## Shared types

Обязательно:

- `ResolvedTeamMember.agentId?: string`

## Graph node identity

Обязательно:

- member node ids переходят на `stableOwnerId`

Нормативный шаблон `v1`:

```ts
member:${teamName}:${stableOwnerId}
```

### Что сознательно не меняем в этом refactor

Существующие UI/event ports могут по-прежнему использовать:

- `teamName`
- `memberName`
- `taskId`

если это нужно для открытия профиля, task detail или других UI-paths.

То есть stable ids обязательны для layout identity и planner storage, но не требуют в этом pass перепридумывать весь пользовательский navigation/event contract.

## Renderer-side layout state

Нужно добавить owner slot assignment storage по team.

Дополнительно нужен технический marker текущего layout path, например:

```ts
slotLayoutVersion = 'stable-slots-v1'
```

Он поможет безопасно отличать новый planner path от старого во время миграции и cleanup.

### Versioning contract

- `slotLayoutVersion` хранится рядом с member slot assignments
- если сохранённая версия не совпадает с текущей, старые member assignments нужно сбросить и пересчитать по planner defaults
- не нужно пытаться поддерживать неявную backwards-совместимость между разными planner semantics

Лучше один явный reset assignments path, чем тихое использование устаревшей geometry-модели.

## Internal planner types

Нужны internal-only helper types:

- `SlotFrame`
- `UnassignedTaskSlotFrame`
- `OwnerSlotAssignment`
- `OwnerFootprint`
- `RingPlanCandidate`
- `StableSlotLayoutSnapshot`

Эти типы лучше держать в feature domain / graph package internals, а не тянуть в публичный API без необходимости.

### Нормативный `StableSlotLayoutSnapshot` для `v1`

Чтобы renderer и simulation не собирали layout из полусырых кусков, фиксируем aggregated result type:

```ts
type StableSlotLayoutSnapshot = {
  teamName: string;
  slotLayoutVersion: string;
  memberSlotFrames: SlotFrame[];
  leadCentralReservedBlock: Rect;
  unassignedTaskSlot?: UnassignedTaskSlotFrame;
  runtimeCentralExclusion: Rect;
  fitBounds: Rect;
};
```

### Зачем нужен snapshot

- один planner run должен выдавать один цельный результат
- renderer не должен сам дособирать geometry из отдельных store-полей
- validation должна проверять именно полный snapshot, а не куски по отдельности

Это уменьшает риск, что `Activity`, `Tasks`, `Process`, fit bounds и exclusion будут жить в слегка разных версиях одного и того же layout pass.

## Слои и ответственности

## Shared / main

Точки внимания:

- `src/shared/types/team.ts`
- `src/main/services/team/TeamMemberResolver.ts`

Ответственность:

- протащить `agentId` в `ResolvedTeamMember`
- сделать stable identity доступной renderer-слою

## Feature domain

Точки внимания:

- `src/features/agent-graph/core/domain/`

Ответственность:

- `stableOwnerId`
- `slotWidth/slotHeight`
- width buckets
- ring planner
- slot validity checks
- drag/snap helpers

## Adapter layer

Точки внимания:

- `src/features/agent-graph/renderer/adapters/TeamGraphAdapter.ts`

Ответственность:

- строить member node ids на stable owner id
- привязать tasks / processes / activity к stable owner identity
- не заниматься спасением geometry post-facto

## Graph package layout

Точки внимания:

- `packages/agent-graph/src/hooks/useGraphSimulation.ts`
- `packages/agent-graph/src/layout/kanbanLayout.ts`
- `packages/agent-graph/src/layout/activityLane.ts`

Ответственность:

- owner placement идёт от slot planner, а не от free-force
- task layout получает `slot frame`
- activity получает `slot-local origin`
- process rail позиционируется owner-local

## Renderer UI

Точки внимания:

- `src/features/agent-graph/renderer/ui/GraphActivityHud.tsx`
- `src/features/agent-graph/renderer/ui/GraphProvisioningHud.tsx`
- `src/features/agent-graph/renderer/ui/GraphNodePopover.tsx`

Ответственность:

- быть consumer-слоем готовой geometry
- не быть главным solver-ом layout
- сохранить существующие полезные interactions

## Подробный implementation plan

Ниже порядок, который уменьшает риск наломать багов.

## Phase gates - когда можно идти дальше

Это не просто список задач по порядку. Между фазами есть обязательные quality gates.

### Нельзя переходить к slot UI integration, пока не выполнено

- stable identity уже протянута до graph layer
- planner helpers уже pure и покрыты базовыми unit tests
- `slotAssignmentsByTeam` уже стал source of truth
- planner уже выдаёт валидный `StableSlotLayoutSnapshot`
- validation pass уже работает
- snapshot lifecycle и fail-closed commit behavior уже определены и подключены

### Нельзя считать activity/process/tasks phase завершённой, если

- для позиционирования всё ещё используется screen-space self-packing
- renderer сам высчитывает geometry вместо consumption `slot frame` и local anchors
- overlap "чинится" постфактум DOM-side коррекцией

### Нельзя удалять старые geometry paths, пока не доказано

- `Activity`
- `Process`
- `Tasks`
- fit / camera
- drag / snap / swap

уже работают на новом planner path без регрессии ключевых UX-сценариев.

## Phase 0 - audit and kill-switch cleanup

### Цель

Перед тем как писать новый planner, зафиксировать, какие текущие механизмы нужно убрать или перестать считать source of truth.

### Сделать

1. Найти текущие owner-related packers и manual reposition paths
2. Отдельно отметить:
   - screen-space activity pack
   - owner free-force assumptions
   - raw pinning paths
3. Зафиксировать, что после migration source of truth будет slot planner

### Результат

Список устаревающих механизмов и мест, которые должны стать no-op или быть удалены на финальной фазе.

## Phase 0.5 - temporary rollout guard

### Цель

Внедрять новый planner безопасно и иметь быстрый способ локально сравнить новое поведение со старым.

### Сделать

1. Добавить временный internal switch / feature flag для нового planner path
2. Оставить возможность локально переключать:
   - current layout
   - stable slot layout
3. После достижения parity удалить переключатель или сделать его технически неактивным

### Rollout contract

Feature flag должен переключать **целый layout mode**, а не отдельные куски.

Если включён новый path:

- owner placement идёт только от stable-slot planner
- activity/process/tasks берут geometry только из нового slot path
- старые owner pack/reposition механизмы не должны параллельно влиять на те же owner-local зоны

Если включён старый path:

- новый planner может жить только как dev/test path
- его geometry не должна подмешиваться в production rendering случайно

### Что запрещено

- mixed mode, где tasks уже от нового slot frame, а activity всё ещё пакуется старым screen-space способом
- mixed mode, где новый planner строит assignments, но старый renderer потом "допихивает" geometry
- включение feature flag только для одной owner-local подсистемы без согласованного переключения всей owner-local topology модели

### Done when

- новый planner можно изолированно проверять во время разработки, не ломая возможность сравнения

## Phase 1 - stable identity plumbing

### Цель

Убрать хрупкую зависимость layout от display name.

### Сделать

1. Добавить `agentId?: string` в `ResolvedTeamMember`
2. Протащить `agentId` через `TeamMemberResolver`
3. Добавить helper `getStableOwnerId(member)`
4. Перевести member node ids на stable owner id
5. Проверить все ссылки `task.ownerId`, `process owner`, `activity owner`

### Done when

- rename при том же `agentId` больше не меняет graph identity owner node

## Phase 2 - slot state and planner helpers

### Цель

Вынести геометрию и planner из UI-слоя в чистые helper-и.

### Сделать

1. Добавить типы:
   - `OwnerSlotAssignment`
   - `SlotFrame`
   - `OwnerFootprint`
   - `StableSlotLayoutSnapshot`
2. Реализовать pure helpers:
   - `computeOwnerFootprint`
   - `classifyWidthBucket`
   - `buildCentralExclusion`
   - `buildOwnerAnchor`
   - `buildSlotFrameFromOwnerAnchor`
   - `buildSlotLocalOrigins`
   - `buildUnassignedTaskSlotFrame`
   - `planOwnerSlots`
   - `resolveNearestSlot`
   - `isSlotAssignmentValid`
   - `computeRingRadius`
3. Добавить min-gap / ring-gap constants в одном месте
4. Собрать planner result в единый snapshot и валидировать его до render/commit

### Done when

- planner можно покрыть unit tests без React и без canvas

## Phase 3 - renderer-side slot assignment storage

### Цель

Сделать persistent source of truth для owner placement.

### Сделать

1. Добавить store-state `slotAssignmentsByTeam`
2. Хранить assignments по `stableOwnerId`
3. Добавить actions:
   - `setOwnerSlotAssignment`
   - `swapOwnerSlots`
   - `clearTeamSlotAssignments`
   - `resetTeamSlotAssignmentsToPlannedDefaults`
4. Продумать first-load migration для старых raw pinning paths
5. Явно зафиксировать, что storage относится только к member sector slots, а не к lead/unassigned geometry
6. Добавить compare-and-reset semantics для `slotLayoutVersion`
7. Добавить one-time migration path `fallback member.name -> agentId`, если assignment уже существовал
8. Зафиксировать precedence между version reset, existing stable assignment и fallback migration

### Done when

- owner placement переживает refresh и не зависит от случайной d3-стабилизации
- legacy owner pinning больше не конкурирует со slot assignment как второй source of truth
- `slotLayoutVersion` mismatch сбрасывает старые member assignments предсказуемо
- existing fallback assignment может сохраниться при переходе `member.name -> agentId`
- version reset и fallback migration не создают две конкурирующие записи для одного member-а

## Phase 4 - integrate planner into graph simulation

### Цель

Сделать owner positions planner-derived.

### Сделать

1. `useGraphSimulation` получает slot frames
2. Lead фиксируется в центре
3. `unassigned task slot`, если нужен, строится как special fixed frame под lead
4. Member node positions берутся из slot frames
5. Free-force больше не определяет owner layout
6. Если d3-force остаётся, он не должен двигать owners вне slot planner-а

### Done when

- owner topology не меняется из-за zoom, pan или случайного re-tick

## Phase 5 - task band integration

### Цель

Встроить kanban в slot frame без cross-owner overlap.

### Сделать

1. `KanbanLayoutEngine` начинает работать от `slot frame`
2. Сохраняем current column order / semantics
3. Считаем реальный `kanbanWidth`
4. Ограничиваем task band по `5 rows`
5. Реализуем overflow stack per column
6. Явно сохранить существующий column order source, не вводя новый sort-rule
7. Отдельно встроить `unassigned task slot` как special pseudo-owner case:
   - без `activity band`
   - без `process band`
   - с теми же bounded task rules

### Done when

- tasks не залезают в activity zone соседнего owner
- unassigned tasks больше не теряются и не "прилипают" к случайным member slots

## Phase 6 - process rail integration

### Цель

Прикрепить process к owner slot.

### Сделать

1. Убрать свободное process placement
2. Привязать process presentation к process band внутри slot
3. Сохранить current visual style
4. Ограничить до одного релевантного process rail для `v1`

### Done when

- process перестаёт быть отдельным плавающим источником хаоса

## Phase 7 - activity band integration

### Цель

Сделать activity частью slot, а не внешним solver-ом.

### Сделать

1. `GraphActivityHud` перестаёт pack-ить owners
2. Получает slot-local coordinates
3. Рисует local connector
4. Сохраняет existing compact message UI
5. Сохраняет `+N more -> Activity tab`
6. Сохраняет deterministic `newest first` + tie-break path
7. Удаляет screen-space self-packing и DOM-measurement-driven repositioning из activity path

### Done when

- activity больше не может сместиться независимо от owner slot

## Phase 8 - drag / snap / swap

### Цель

Сохранить manual control, не ломая стабильность.

### Сделать

1. Drag разрешён только для member slots
2. На drop находим nearest valid slot
3. Если slot занят, делаем `swap`
4. Сохраняем assignment
5. Обновляем planner state без full random reshuffle

### Done when

- drag меняет slot assignment, а не свободную world position

## Phase 9 - fit / bounds / camera

### Цель

Чтобы camera видела реальный layout.

### Сделать

1. `zoomToFit` учитывает полные slot bounds
2. Учитывать:
   - activity bands
   - task bands
   - process rails
   - central exclusion
   - unassigned task slot
3. Проверить initial fit и manual fit

### Done when

- fit больше не обрезает реальные owner-local зоны

## Phase 10 - cleanup old geometry paths

### Цель

Убрать старые механизмы, которые будут конфликтовать с новым planner-ом.

### Сделать

1. Удалить или задизейблить устаревший owner overlap pack path
2. Удалить owner-specific reliance on raw pinning
3. Удалить activity self-packing logic, если она больше не нужна
4. Проверить, что остались только необходимые world transforms

### Done when

- в коде остаётся один понятный source of truth для owner layout

## Phase 11 - parity review

### Цель

Перед финальным merge проверить, что новый planner не потерял уже работающие UX-paths.

### Проверить

1. `+N more -> Activity tab`
2. existing activity item click behavior
3. process visual styling
4. lead launch HUD
5. fit / zoom controls
6. graph tab / fullscreen shared layout behavior
7. filters не вызывают layout jumps

### Done when

- новый layout стабилен и не деградирует уже полезные interaction-ы

## Recommended PR split

Чтобы этот refactor было реально безопасно довезти, лучше не делать его одним гигантским diff.

Рекомендуемая нарезка:

### PR 1 - stable identity and slot state

- `agentId -> ResolvedTeamMember`
- `stableOwnerId`
- новые member node ids
- `slotAssignmentsByTeam`
- migration policy для legacy pinning

### PR 2 - pure planner and simulation integration

- `OwnerFootprint`
- `SlotFrame`
- planner helpers
- `validateStableSlotLayout`
- `StableSlotLayoutSnapshot`
- ring/sector logic
- интеграция planner-а в `useGraphSimulation`

### PR 3 - task/process/activity slot integration

- `KanbanLayoutEngine` от `slot frame`
- process rail inside slot
- activity inside slot
- local anchors / connector path

### PR 4 - drag, fit, cleanup, parity

- drag/snap/swap
- reset-layout path
- fit bounds
- удаление старых geometry paths
- parity review и финальный cleanup

Если в реальности придётся объединить PR 2 и PR 3 - это ещё допустимо. Но делать всё одним большим PR хуже по риску и по способности нормально проверить регрессии.

## Тест-план

Ниже обязательные тесты, без которых этот refactor нельзя считать завершённым.

## Identity / ordering

- `ResolvedTeamMember.agentId` проходит до graph layer
- member node id строится на `stableOwnerId`
- rename при том же `agentId` не меняет slot assignment
- fallback на `member.name` работает, если `agentId` отсутствует
- duplicate `agentId` или duplicate fallback `member.name` не приводят к silent merge owners
- existing fallback assignment корректно мигрирует на `agentId`, если `agentId` появился позже
- hidden member при возвращении с тем же `stableOwnerId` пытается переиспользовать прежний assignment
- initial ordering стабилен и совпадает с `config.members[]`

## Planner

- owner slots не пересекаются друг с другом
- owner slots не пересекают central exclusion
- `leadCentralReservedBlock` не схлопывается от hidden launch HUD или пустого lead activity state
- `SlotFrame` строится по канонической формуле от `ownerAnchor`
- `activityOrigin/processOrigin/taskOrigin` детерминированно выводятся из `SlotFrame`
- validator ловит `NaN/Infinity` в frame-ах и bounds
- validator ловит duplicate assignment-ы
- validator проверяет, что band-local anchors не вылезают из своего `SlotFrame`
- при validation failure новый broken layout не перетирает последний валидный snapshot
- один planner run собирает один цельный `StableSlotLayoutSnapshot`
- snapshot коммитится атомарно, без частичного обновления `SlotFrame`/`fitBounds`/`central exclusion`
- ring 1 overflow создаёт ring 2
- один ring не принимает больше одного owner на один sector anchor
- existing valid assignments сохраняются
- invalid assignment перепланируется локально, без полного reshuffle
- planner сначала пытается сохранить сектор, потом увести owner на внешний ring
- planner работает в world coordinates и не зависит от camera zoom/pan
- planner не пытается сам разместить `lead` или `unassigned task slot`
- planner не запускается как полноценный stable-sector layout без `lead`
- при конфликте из-за роста одного owner footprint planner сначала пытается двигать именно этот owner, а не весь ring

## Tasks

- task band ограничен `5 rows`
- overflow stack работает per column
- все active non-empty columns показываются
- slot width растёт при росте числа columns
- current канонический order внутри column сохраняется
- задачи без owner-а попадают в отдельный `unassigned task slot`
- задачи с owner-ом, который сейчас не видим или не существует, тоже уходят в `unassigned task slot`

## Activity

- activity band показывает `3` items
- `+N more` считается корректно
- comments показывают target task, а не fake-recipient member
- activity order внутри slot - newest first
- tie-break при одинаковом timestamp детерминирован и стабилен
- `+N more` открывает профиль на вкладке `Activity`

## Process

- process rail остаётся owner-local
- running process имеет приоритет над finished
- пустой process band не вызывает layout jump

## Drag / persistence

- drop снапает в nearest valid slot
- занятый target slot делает `swap`
- невалидный drop возвращает owner в прежний assignment
- refresh сохраняет slot assignments
- zoom/pan не меняют owner placement
- graph tab и fullscreen overlay используют один и тот же member slot state
- graph tab и fullscreen overlay могут иметь разный camera state
- `slotLayoutVersion` mismatch сбрасывает устаревшие member assignments
- fallback migration `member.name -> agentId` не создаёт дубли assignment-ов
- team switch не смешивает assignments разных команд
- если одна команда открыта в нескольких pane-ах, layout state у них общий и синхронизируется через shared store
- no-lead transient state не портит persistent assignments
- validation failure не делает invalid snapshot active render geometry
- no-lead path не делает stale stable-slot snapshot активным render-path вместо fallback UI
- snapshot cache не подменяет `slotAssignmentsByTeam` как placement source of truth

## Fit / camera

- initial fit учитывает slot bounds
- manual fit учитывает slot bounds
- initial fit учитывает `unassigned task slot`
- manual fit учитывает `unassigned task slot`
- initial fit учитывает `lead central reserved block`
- manual fit учитывает `lead central reserved block`
- zoom меняет только camera transform
- pan меняет только camera transform
- filters не меняют topology bounds, которые использует fit

## Filters

- `showTasks` не меняет slot topology
- `showProcesses` не меняет slot topology
- `showEdges` не меняет slot topology
- скрытие tasks/processes не убирает reserved band geometry и не вызывает layout jump
- `showTasks = false` не удаляет topology footprint у `unassigned task slot`, если в dataset всё ещё есть unassigned tasks

## Team scoping

- `slotAssignmentsByTeam` изолирует layout state по `teamName`
- team switch не переиспользует assignments от другой команды
- параллельно открытые graph panes не должны ломать team-scoped layout друг друга

## Rollout / flag behavior

- feature flag не включает mixed mode между старым и новым owner-local layout path
- при включённом новом path activity/process/tasks используют один и тот же stable-slot geometry source
- старый owner pack/reposition path не влияет на новый stable-slot render path

## Dense teams

- граф с большим числом участников уходит во второй ring, а не превращается в overlap-chaos
- широкие slots не придавливают соседние owner zones
- lead central zone остаётся чистой
- появление `unassigned task slot` не ломает весь ring-layout глобальным reshuffle

## Самые слабые места и что проверять особенно внимательно

## 1. Stable identity

Если тут останется хотя бы один тихий fallback на `member.name` в layout storage, всё снова станет хрупким.

И отдельно:

- если silent merge случится из-за неуникального `agentId` или `member.name`, это сломает сразу и slot assignments, и drag, и ownership links

## 2. Slot width growth

Это самый рискованный geometry block после identity, потому что пользователь сознательно выбрал:

- показывать все columns
- не вводить scroll
- не cap-ить visible columns

## 3. Partial replanning

Самая большая UX-ошибка тут - случайно делать global reshuffle там, где достаточно локального spill на outer ring.

## 4. Lead central exclusion

Если planner забудет учесть хотя бы один из центральных блоков:

- lead
- launch HUD
- lead activity

то первый ring начнёт врезаться в центр.

## 5. Old geometry paths

Если оставить старые packers и force-assumptions живыми параллельно, новый planner будет "исправляться" чужой логикой, и баги станут трудноотлавливаемыми.

## 6. World-space vs screen-space mixing

Это самый коварный класс багов после identity.

Если хотя бы один owner-local слой снова начнёт:

- сам себя pack-ить в screen-space
- двигаться из DOM measurements
- учитывать текущий zoom как вход planner-а

то визуально всё опять будет "плавать" отдельно от графа.

## Запрещённые переинтерпретации плана

Ниже короткий список вещей, которые implementer не должен "упростить по ходу", потому что именно так обычно и возвращаются старые баги.

- нельзя трактовать `Activity` как свободный overlay поверх итогового layout
- нельзя трактовать `lead` как обычный member slot только с особыми стилями
- нельзя сохранять raw `x/y` "временно, пока не доделаем slot assignment"
- нельзя позволять filters менять topology, даже если визуально это кажется проще
- нельзя схлопывать `lead activity frame` или `launch HUD frame` только потому, что они сейчас не видимы
- нельзя строить `SlotFrame` отдельно в planner и отдельно в renderer с немного разными формулами
- нельзя заменять local replanning глобальным reshuffle только потому, что так проще написать первую версию
- нельзя допускать, чтобы fullscreen и tab считали layout независимо друг от друга
- нельзя лечить overlap постфактум screen-space сдвигами вместо исправления planner-а или footprint contract

Если для какой-то задачи кажется, что одно из этих правил "мешает быстро доделать", значит меняется не реализация плана, а сам план. Это нужно сначала явно переоткрыть как product/architecture decision, а не менять молча по коду.

## Acceptance criteria

- [ ] lead остаётся центральным anchor
- [ ] lead использует central reserved block, а не обычный member slot
- [ ] `leadCentralReservedBlock` детерминированно собирается из lead activity frame, lead core frame и launch HUD frame
- [ ] member slots распределяются по стабильным секторам
- [ ] second ring работает по footprint-budget, а не по member count
- [ ] stable owner id построен на `agentId`, с fallback на `member.name`
- [ ] member node ids больше не name-based
- [ ] slot assignment хранится отдельно от raw `x/y`
- [ ] `slotAssignmentsByTeam` хранит только member sector assignments, а не lead/unassigned geometry
- [ ] persistent layout state ограничен assignment-ами и version marker-ом, а geometry остаётся derived
- [ ] `slotLayoutVersion` mismatch безопасно сбрасывает старые member assignments
- [ ] existing fallback assignment может мигрировать на `agentId`, если `agentId` появился позже
- [ ] precedence между version reset, stable assignment и fallback migration определена и не создаёт дублей
- [ ] slot geometry считается в world coordinates и не чинится screen-space packer-ом
- [ ] `SlotFrame` строится по одному каноническому правилу от `ownerAnchor`, без альтернативных renderer-side трактовок
- [ ] geometry constants живут в одном stable-slot layout module и не дублируются по коду
- [ ] renderer/simulation получают один цельный `StableSlotLayoutSnapshot`, а не набор несвязанных geometry-кусочков
- [ ] planner output проходит отдельную validation pass перед commit/render
- [ ] validation failure не приводит к partially-broken render и не записывает невалидные assignments в store
- [ ] один layout update коммитится атомарно, без смешивания старых и новых поколений geometry state
- [ ] session-local last valid snapshot cache не становится альтернативным source of truth для placement
- [ ] no-lead path не коммитит новый stable-slot snapshot и не подменяет fallback render stale snapshot-ом
- [ ] runtime precedence между assignments, active snapshot, snapshot cache и fallback path соблюдается без mixed-state
- [ ] tasks bounded по высоте до `5 rows`
- [ ] activity bounded до `3 items`
- [ ] все active non-empty kanban columns показываются
- [ ] slot width может расти
- [ ] unassigned tasks живут в отдельном bounded slot под lead
- [ ] process attached к owner slot
- [ ] drag работает через snap-to-slot
- [ ] occupied slot приводит к swap
- [ ] invalid drop возвращает owner в прежний slot
- [ ] zoom/pan не меняют owner topology
- [ ] graph tab и fullscreen overlay разделяют один и тот же layout state
- [ ] graph tab и fullscreen overlay могут иметь независимый camera state без расхождения layout
- [ ] graph filters не перестраивают slot topology
- [ ] `showTasks = false` не убирает topology footprint у `unassigned task slot`, если dataset не изменился
- [ ] team switch не смешивает layout state разных команд
- [ ] team rename не обязан мигрировать layout state в `v1` и это явно осознано как tradeoff
- [ ] одна и та же команда в нескольких pane-ах использует общий shared layout state
- [ ] hidden member при возвращении с тем же `stableOwnerId` может переиспользовать прежний assignment
- [ ] no-lead transient state не порождает случайный persistent layout
- [ ] fit использует topology bounds, а не только текущую видимую presentation
- [ ] fit учитывает полные slot bounds
- [ ] dense teams больше не превращают graph в overlay-chaos

## Итоговое решение в одной секции

Финально мы пришли вот к чему:

- берём `Variant 3`
- делаем `stable sectors around lead`
- фиксируем `6` sector anchors в `v1`
- добавляем `second ring`
- считаем ring capacity по footprint-budget
- используем `S / M / L` только как packing heuristic
- показываем все active non-empty kanban columns
- ограничиваем task band по высоте до `5 rows`
- ограничиваем activity band до `3 items`
- unassigned tasks уводим в отдельный bounded slot под lead
- process делаем attached sub-rail owner-а
- drag делаем через snap и swap
- slot assignment храним отдельно
- stable owner identity строим на `agentId`, fallback на `member.name`

Это и есть зафиксированный target-state для следующей большой переделки graph layout.

## Что ещё можно тюнить без изменения архитектуры

Блокирующих product-level вопросов не осталось.

Разрешён только визуальный и micro-spacing tuning, который не меняет planner semantics:

- padding внутри activity item shell
- точные visual offsets process rail
- glow / shadow / label spacing

Нельзя под видом тюнинга менять:

- source of truth
- slot assignment model
- ring planner semantics
- bounded band rules
- drag/snap/swap rules

## IOF execution checklist

Это короткий practical checklist, по которому удобно идти во время реализации, чтобы не потерять зафиксированные решения.

1. Сначала убедиться, что `ResolvedTeamMember` реально получил `agentId` и что graph member node ids перестали зависеть от `member.name`.
2. До включения нового planner path зафиксировать все места, где старый код всё ещё двигает owners через force/pack/pinning.
3. Вынести slot geometry в pure helpers до переписывания UI.
4. Сначала сделать planner и его unit tests, и только потом подключать UI.
5. Прежде чем трогать `GraphActivityHud`, зафиксировать один канонический `ownerAnchor/activityOrigin/processOrigin/taskOrigin`.
6. Не трогать одновременно и data model, и visual tuning, пока planner не стал детерминированным.
7. После интеграции planner-а отдельно проверить, что zoom/pan больше не влияют на topology.
8. После интеграции task band отдельно проверить dense-team cases, где slot width растёт.
9. После интеграции drag отдельно проверить invalid drop, swap и reset-layout.
10. Отдельно проверить cases без owner-а и с "битым" owner reference, чтобы такие задачи гарантированно уходили в `unassigned task slot`.
11. Перед cleanup старых paths убедиться, что новый planner покрывает `Activity`, `Process`, `Tasks` и fit bounds.
12. Перед финальным merge вручную проверить `+N more -> Activity`, launch HUD и process visual parity.
13. Не мержить состояние, где в коде остаются два равноправных source of truth для owner placement.
