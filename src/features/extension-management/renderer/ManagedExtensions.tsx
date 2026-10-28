import { useManagedExtensions } from './hooks/useManagedExtensions';
import { ManagedExtensionsPanel } from './ui/ManagedExtensionsPanel';

export const ManagedExtensions = ({ kind }: { kind: 'plugin' | 'skill' }) => {
  const model = useManagedExtensions(kind);
  return <ManagedExtensionsPanel kind={kind} model={model} />;
};
