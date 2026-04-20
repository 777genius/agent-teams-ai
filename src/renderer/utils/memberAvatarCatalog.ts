import avatar01 from '@renderer/assets/participant-avatars/01.png';
import avatar02 from '@renderer/assets/participant-avatars/02.png';
import avatar03 from '@renderer/assets/participant-avatars/03.png';
import avatar04 from '@renderer/assets/participant-avatars/04.png';
import avatar05 from '@renderer/assets/participant-avatars/05.png';
import avatar06 from '@renderer/assets/participant-avatars/06.png';
import avatar07 from '@renderer/assets/participant-avatars/07.png';
import avatar08 from '@renderer/assets/participant-avatars/08.png';
import avatar09 from '@renderer/assets/participant-avatars/09.png';
import avatar10 from '@renderer/assets/participant-avatars/10.png';
import avatar11 from '@renderer/assets/participant-avatars/11.png';
import avatar12 from '@renderer/assets/participant-avatars/12.png';
import avatar13 from '@renderer/assets/participant-avatars/13.png';

export const PARTICIPANT_AVATAR_URLS = [
  avatar01,
  avatar02,
  avatar03,
  avatar04,
  avatar05,
  avatar06,
  avatar07,
  avatar08,
  avatar09,
  avatar10,
  avatar11,
  avatar12,
  avatar13,
] as const;

export const LEAD_PARTICIPANT_AVATAR_URL = PARTICIPANT_AVATAR_URLS[0];

export function getParticipantAvatarUrlByIndex(index: number): string {
  const normalized =
    ((Math.trunc(index) % PARTICIPANT_AVATAR_URLS.length) + PARTICIPANT_AVATAR_URLS.length) %
    PARTICIPANT_AVATAR_URLS.length;
  return PARTICIPANT_AVATAR_URLS[normalized];
}
