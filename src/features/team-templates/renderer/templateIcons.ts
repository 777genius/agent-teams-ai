import {
  ClipboardList,
  CodeXml,
  GraduationCap,
  Handshake,
  Headset,
  type LucideIcon,
  Megaphone,
  PenLine,
  Search,
} from 'lucide-react';

import type { TeamTemplateV1 } from '../contracts';

/** The one icon per catalogue entry; every surface that lists templates uses it. */
export const TEAM_TEMPLATE_ICONS = {
  'software-product': CodeXml,
  marketing: Megaphone,
  content: PenLine,
  research: Search,
  sales: Handshake,
  'customer-support': Headset,
  operations: ClipboardList,
  learning: GraduationCap,
} satisfies Record<TeamTemplateV1['id'], LucideIcon>;
