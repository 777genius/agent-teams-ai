import { installStandardOutputGuard } from './utils/standardOutputGuard';
import { installTestChildProcessTrace } from './utils/testChildProcessTrace';

installStandardOutputGuard(process.stdout);
installStandardOutputGuard(process.stderr);
installTestChildProcessTrace();
