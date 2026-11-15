
## 15 ноября: проверка оставшегося замечания о транспортном резерве

На объединённом `9a34bb28de0a0deee2eecc42099fd9500563eb1b` замечание
[#1192/4568304854](https://github.com/777genius/agent-teams-ai/pull/1192#discussion_r4568304854)
остаётся воспроизводимым по исходному пути: при `maxPriorityMessages <=
reservedControlRequests` исходящие work-запросы не получают ни одного места.
Штатные лимиты 64/8 корректны; это отдельный дефект явной конфигурации,
не диагноз текущего Windows OpenCode E2E.

Проверенный ограниченный объём: отказ при создании Host с `nativeCustody`
и при принятии Main handshake, до готовности к work-запросам. Общие resolvers,
лимиты, control reserve и transport-only Host с очередью из одного сообщения
сохраняются. Два существующих fixture-файла проверяют неверную конфигурацию,
минимальную рабочую ёмкость и прежний overflow; новые абстракции не нужны.
Ожидается менее 10 production LOC. Root проверил границы независимо; исходные
проверки выполняются последовательно до и после исправления. Их результаты
не заменяют ожидающие Electron/native проверки на опубликованном source.

Фактическая проверка на Node 24.21.0: до изменения production исходный полный
transport-файл дал 12 PASS / 1 ожидаемый FAIL, полный Main client-файл —
31 PASS / 2 ожидаемых FAIL; все три отказа проверок вызваны принятием неверной
конфигурации. После двух guards те же файлы дали 13/13 и 33/33 PASS, без SKIP.
Host build, полный Host test typecheck на TS 7.0.2, scoped fast lint четырёх
изменённых файлов, source-size, provisioning guard и diff check прошли.
Текущий source cap 800 и прежний transport-only overflow сохранены.

## 15 ноября: наблюдатель Windows source использует захваченный бюджет

На `9a34bb28` исходные Windows source проверки корректно остались INCOMPLETE:
x64 OpenCode отказал по истёкшему 15-секундному preparation, ARM64 Codex был
остановлен наблюдателем во время повторной обязательной проверки готовности.
Оба original receipt подтверждают cleanup. Неуспешные результаты сохраняются:
[x64](https://github.com/777genius/agent-teams-ai/actions/runs/43751070810/job/132924970626),
[ARM64](https://github.com/777genius/agent-teams-ai/actions/runs/43751070810/job/132924970687).

Проверка истории установила несоответствие TEST-настроек. `d894df69792` добавил
общий poll 15 с и Host request 15 с вместе с уже выбранным runtime 90 с.
Desktop non-V2 fixture с `2dc2e18af8f` использует request 60 с и прямо отделяет
workflow acceptance от проверки скорости запуска. Исходные Stage 1/P09 не
задают 15-секундный startup SLO. Поздние записи Plan29, сохранявшие 15 с для
отдельных исправлений, остаются историей тех срезов; эта ограниченная поправка
меняет только следующие TEST-настройки после независимого review.

- OpenCode source Host получает тот же request budget 60 с, что существующий
  Desktop non-V2 fixture. Это относится ко всем его RPC; Claude/Codex request
  остаётся 15 с. Production продолжает соблюдать выбранный caller profile;
  универсальный production default 60 с не вводится. Private Team probe по
  runtime profile имеет 90 с и ограничивается исходным Main anchor (теперь не
  более 60 с), а отдельный management model probe сохраняет 30 с.
- Только Codex Team-ready observer берёт timeout исходного captured member,
  проверяя его полный binding, launch/roster и fresh unclaimed attempt. Один
  монотонный deadline начинается перед исходным Start; в прежний poll передаётся
  остаток. Получение ACK и опросы не возобновляют бюджет. Остальные poll calls,
  включая OpenCode post-Start, сохраняют прежний default 15 с.

Production, provider SPI, проверки свежести/источника, модельные и бизнес-вызовы,
actor lifetime, Stop/cleanup и внешний controller 120 с не меняются. Изменения
не доказывают успех нового source: обе оригинальные Windows архитектуры должны
пройти тот же полный A/B и cold scenario после публикации.

Root и независимый reviewer проверили фактический двухфайловый diff, исходные
summary/binding поля и включение обоих файлов в прежние source pins. Полный
scripts typecheck (TS 7.0.2), scoped fast lint, source-size и diff check прошли;
новых тестовых helpers, profiling protocol или production performance changes
не добавлено. Native Windows результат этой поправки пока не заявляется.

### Следующие original Windows observations на `2cb0c0a9`

[ARM64](https://github.com/777genius/agent-teams-ai/actions/runs/43755682747/job/132939165328)
подтвердил готовность обеих Codex Teams за 15,76/15,78 с. Следующий original
standalone run был ещё `running`, когда его общий TEST poll оборвался через
15,47 с. Все 24 подготовленных процесса подтвердили отсутствие; ещё один Job
был allocated непосредственно перед cleanup, без staging/root/resume, и получил
Stop/drain/release. Строгий source receipt остался `cleanup=false`, внешний
controller подтвердил отсутствие процессов. Этот run не засчитывается как PASS.

[x64](https://github.com/777genius/agent-teams-ai/actions/runs/43755682747/job/132939165622)
полностью прошёл Codex и Claude source scenarios; OpenCode прошёл подготовку,
но следующий общий poll остановил `opening` через 15,19 с. Отказа по expiry в
этом receipt нет, все исходные Jobs очищены. Полный OpenCode scenario остаётся
INCOMPLETE.

Для этих двух наблюдений применяется уже установленное правило captured budget:
OpenCode Team-ready использует ту же проверку исходного member и один deadline
до подготовки/Start; Codex standalone использует timeout исходного recipe,
связанного с сохранённым run через input/source/teamScope/member/recipeDigest.
Существующее чтение standalone capture перенесено сразу после Start; нового RPC
или повторного запуска нет. Это консервативный TEST budget по timeout native
operations, а не новый общий product wall-clock limit standalone; время Start/ACK
входит в бюджет наблюдателя. Прежние success,
cold replay и cleanup assertions, общий poll default для остальных вызовов,
production deadlines и controller 120 с сохранены. Новая native приёмка нужна
на следующем опубликованном source; результаты `2cb0c0a9` не переименовываются.

### Исходный Desktop peer между census и записью launch

Замечания #1192/4567946375 и /4567946386 воспроизведены на прежнем observer:
короткий catalog peer может завершиться до отдельного argv read, а новый peer
может ещё не записать launch. Наблюдатель теперь сохраняет один исходный census
с argv/parent/group/birth и за общий бюджет 3 с ожидает единственную исходную
launch row. Живой процесс должен сохранить исходные поля; завершившийся требует
свежего подтверждения отсутствия. Несовпадение, неоднозначность и истечение
бюджета остаются отказами; PID не используется для сигналов или новой authority.
Это ограниченное TEST-наблюдение `ps`, не kernel HANDLE и не универсальная ABA proof.

В существующем observations test file: до исправления 26 PASS / 7 ожидаемых FAIL
при 25 прошедших прежних проверках; после — 33/33 PASS, без SKIP, Node 24.21.0.
Root дополнительно воспроизвёл потерю Unicode argv у `ps` в locale C на отдельном
короткоживущем TEST Node и подтвердил его cleanup. Выбрана UTF-8 locale с English
date fields (Linux C.UTF-8, Darwin en_US.UTF-8); fixture содержит пробелы, Я и 路径.
Эта regression дала 31 PASS / 2 ожидаемых FAIL до locale fix и 33/33 PASS после.
Проверки source/provider/role, исходного Host, cleanup и source pins сохранены.
Root R2, полный scripts typecheck на TS 7.0.2, scoped fast lint трёх TEST файлов,
source-size guard и diff check прошли. Эти локальные проверки не заменяют новый
полный native/Electron run на опубликованном source.

## 15 ноября: исходные Windows A/B закрыты; следующие scoped acceptance fixes

На опубликованном `c28f1aa890c909c7b981254c5e30b874cbc84287` полный process
workflow подтвердил Claude, Codex и OpenCode A/B, management и cold scenarios на
[Windows x64](https://github.com/777genius/agent-teams-ai/actions/runs/43759098052/job/132949618051)
и [Windows ARM64](https://github.com/777genius/agent-teams-ai/actions/runs/43759098052/job/132949618151).
Проверены оригинальные ZIP: x64 artifact `14179847488`, SHA-256
`b948518d266e7639ffb4f7f9aed3c2574b9f58902b65f40eaf90df6a266dd736`;
ARM64 artifact `14179294406`, SHA-256
`cc403b00257f38946f0888905bfcf46842fe892685fede6f8e0433bbedf4767e`.
На каждой архитектуре все 25 Codex, 9 Claude и 7 OpenCode исходных Jobs имеют
Stop/drain/release и подтверждённое отсутствие через исходный HANDLE. Codex
standalone завершён; Claude cold Resume сохраняет исходную native session и
добавляет только новый input; cold lookup не повторяет исходные inputs.
OpenCode standalone остаётся вне исходного поддержанного profile. Receipt
явно сохраняет `realProviderExecuted=false`, `desktopQualified=false`,
`releaseQualified=false`; этот PASS не подменяет Desktop или vendor qualification.

Следующий source содержит два ограниченных product исправления замечаний
#1192/4567946530 и /4567946521. При отказе назначения нового Job во время
подтверждённого Stop допускается только debug record того же исходного child
HANDLE, чьё членство в уже завершающемся исходном Job подтверждено заново.
Такой record не получает service authority: current/exact registration, Query,
Stop и settlement не могут использовать его как scope родителя. Подтверждение
dispatch публикуется под существующим mutex сразу после успешного native
syscall; ожидание остаётся вне mutex, исходный deadline не возобновляется.
Не вводятся история HANDLE, новая retention policy или изменение retirement.
Для явно определённого I386/WOW64 процесса принимаются два первоначальных
loader breakpoint; последующие и second-chance exceptions передаются приложению.
API architecture query загружается поздно: новая минимальная версия Windows
не вводится, отсутствие API не разрешает дополнительный WX86 breakpoint.

Существующий TEST debug adapter получает конечный барьер pending CREATE:
один исходный Stop, реальные active Job facts, отказ раннего Settle, отказ обоих
способов регистрации inherited child, отсутствие first-effect marker,
живые original provider/neighbor HANDLEs и последующие Missing после settlement.
В том же native gate проверяются I386 корень и дочерний процесс через штатный
Windows cmd, а также доставка поздних application breakpoints обработчикам.
Барьер и environment selectors отсутствуют в product build. Новый native
результат должен быть получен в CI; source review не является его заменой.

Три прежних evidence gaps исправлены без vendor execution: late model failures
делают Linux SDK receipt INCOMPLETE и завершают процесс с ошибкой; vendor Stop
observer использует свежий query исходного HANDLE вместо живого процесса-свидетеля;
terminal Runtime polling расходует оставшийся исходный phase budget. Проверка
конечного Node witness: 3/3 PASS, без SKIP. Реальный vendor gate не запускался.

Сверка исходной матрицы выявила ещё два пробела текущей приёмки, закрываемых
существующими frontend controls:

- Generic finite Runtime journey открывает уже завершённую исходным cron задачу,
  Task Activity, detail и Task Log Stream. Task command/outbox/input/binding и
  digest retained events связываются с реально отображённым sequence/text.
  Просмотр не добавляет inputs, business commands или provider effects.
- Существующая packaged macOS matrix использует фактические Node/Host/custody
  текущего candidate и конечный Claude SDK peer. Исходные Launch/Stop дают одну
  закрытую session; затем прежний observer выполняет ровно один public
  app.relaunch и один public Quit преемника с writer/session/hash/absence checks.
  Отдельный launch-stop receipt не объявляет full cold Resume/active Quit PASS;
  native custody и natural exit code преемника по-прежнему не квалифицируются.

Root и независимые reviewers проверили native и packaged boundaries. Полные
scripts/native/retained-host typechecks на TS 7.0.2, scoped fast lint без warnings,
source-size (800), provisioning guard, YAML parse и diff check прошли. Actual
Windows C++/Electron и новые UI шаги ожидают CI следующего опубликованного source.
Историческая ordinary solo-DO vendor proof не переименовывается в current finite
peer proof: нынешний peer не выполняет child protocol. Исходная граница P09
остаётся отдельно; её oracle не ослаблялся. Draft, Stage 1 scope, запрет реальных
Claude/Codex запусков и отсутствие main/release/default activation сохранены.
