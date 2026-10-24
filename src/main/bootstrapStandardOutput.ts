import { installStandardOutputGuard } from './utils/standardOutputGuard';

installStandardOutputGuard(process.stdout);
installStandardOutputGuard(process.stderr);
