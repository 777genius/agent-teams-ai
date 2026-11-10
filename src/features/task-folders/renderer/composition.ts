import { FolderController } from '../core/application/folderController';

import { BrowserFolderRepository } from './adapters/browserRepository';
import { PanelController } from './adapters/panelController';
export const folderController = new FolderController(new BrowserFolderRepository());
export const panelController = new PanelController();
