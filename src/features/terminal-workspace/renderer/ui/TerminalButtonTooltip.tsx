import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';

export const TerminalButtonTooltip = ({
  children,
  label,
  side = 'top',
}: Readonly<{
  children: React.ReactElement;
  label: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}>): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side={side}>{label}</TooltipContent>
  </Tooltip>
);
