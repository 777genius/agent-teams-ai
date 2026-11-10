# Планы разработки

Для каждой программы здесь указывается одна актуальная точка входа. Исторические
планы сохраняют исходные пути, чтобы не ломать ссылки и проверенные snapshots.
Статус плана не является статусом реализованного продукта.

| Программа                                       | Читать сначала                                                        | Статус и границы                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Выделение provider-кода и отказ от Claude-форка | [Двухэтапная программа](provider-migration/README.md)                 | Актуальное направление от 21 октября 2026; подробно планируем этап 1 |
| Этап 1: совместимый legacy-host                 | [План реализации](provider-migration/stage-1-legacy-host.md)          | Следующая реализация; отдельные worktrees, без автоматического merge |
| Этап 2: будущие Orchestrator/runtime            | [Границы последующей замены](provider-migration/stage-2-new-cores.md) | Отложен; сейчас не выполняем, вне приёмки этапа 1                                |

Точные RPC/recovery/checkpoint переходы этапа 1 собраны в
[протоколах реализации](provider-migration/stage-1-contracts.md); scope и порядок
фаз остаются в основном плане.

Для этой программы прежний
[план A–F](runtime-provider-extraction-and-claude-sdk-plan.md),
[матрица A–F](runtime-provider-extraction-capabilities.md) и
[кандидат C](runtime-interactive-contract-candidate.md) являются историческими
основаниями и evidence. Они не задают параллельный порядок исполнения.
[Codex source manifest](runtime-provider-extraction-source-manifest.json)
остаётся immutable inventory выбранного донора, не полным списком переноса.

Остальные планы текущей release-работы не перемещаются и не переименовываются
в рамках этой задачи. Их отсутствие в данном индексе не меняет их статуса.

Нормативные правила остаются в
[Feature Architecture Standard](../FEATURE_ARCHITECTURE_STANDARD.md) и
[Team Provisioning Target Architecture](../team-management/team-provisioning-target-architecture.md).
План миграции не отменяет их и не принимает ADR в другом репозитории.
