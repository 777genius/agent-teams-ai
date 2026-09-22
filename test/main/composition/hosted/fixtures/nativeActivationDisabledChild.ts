import { once } from 'node:events';

import { disableHostedNativeActivationInbox } from '../../../../../src/main/composition/hosted/hostedNativeActivationHandle';

const mode = process.argv[3];
if (mode !== 'pending' && mode !== 'late') throw new Error('disabled-native-mode-invalid');

if (mode === 'late') disableHostedNativeActivationInbox();
process.send?.({ contract: 'test.hosted-native-activation-disabled/ready' });

if (mode === 'pending') {
  await once(process.stdin, 'data');
  process.stdin.pause();
  disableHostedNativeActivationInbox();
  process.send?.({ contract: 'test.hosted-native-activation-disabled/disabled' });
}

await once(process, 'disconnect');
