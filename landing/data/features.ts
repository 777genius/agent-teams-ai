import { mdiAccountGroupOutline, mdiViewDashboardOutline, mdiCodeBracesBox, mdiMessageTextOutline, mdiAccountOutline, mdiConsoleLine, mdiChartDonut, mdiSitemapOutline } from '@mdi/js'

export const features = [
  { id: "agentTeams", icon: mdiAccountGroupOutline, key: "agentTeams", accent: "#00f0ff" },
  { id: "kanban", icon: mdiViewDashboardOutline, key: "kanban", accent: "#ff00ff" },
  { id: "codeReview", icon: mdiCodeBracesBox, key: "codeReview", accent: "#39ff14" },
  { id: "tokenUsage", icon: mdiChartDonut, key: "tokenUsage", accent: "#39ff14" },
  { id: "organizations", icon: mdiSitemapOutline, key: "organizations", accent: "#ffd700" },
  { id: "liveProcesses", icon: mdiConsoleLine, key: "liveProcesses", accent: "#ff00ff" },
  { id: "crossTeam", icon: mdiMessageTextOutline, key: "crossTeam", accent: "#ffd700" },
  { id: "soloMode", icon: mdiAccountOutline, key: "soloMode", accent: "#00f0ff" }
] as const;
