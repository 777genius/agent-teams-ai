import { createContext } from 'react';

/** Inactive Teams creation pages keep drafts mounted but suspend portal dialogs. */
export const CreateTeamPageActivityContext = createContext(true);
