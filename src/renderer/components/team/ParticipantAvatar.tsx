import type { ComponentPropsWithoutRef, JSX } from 'react';

type ParticipantAvatarProps = ComponentPropsWithoutRef<'span'> &
  Pick<ComponentPropsWithoutRef<'img'>, 'src' | 'alt' | 'loading'>;

/** Keep avatar layout stable while framing the robot artwork consistently. */
export const ParticipantAvatar = ({
  src,
  alt = '',
  loading = 'lazy',
  className,
  ...props
}: ParticipantAvatarProps): JSX.Element => (
  <span data-participant-avatar className={`block ${className ?? ''}`} {...props}>
    <span
      className="relative block size-full overflow-hidden rounded-[inherit]"
      style={{ objectFit: 'inherit', objectPosition: 'inherit' }}
    >
      <img
        src={src}
        alt={alt}
        loading={loading}
        className="absolute left-1/2 top-1/2 max-w-none"
        style={{
          width: 'calc(100% + 5px)',
          height: 'calc(100% + 5px)',
          objectFit: 'inherit',
          objectPosition: 'inherit',
          transform: 'translate(-50%, calc(-50% + 2px))',
        }}
      />
    </span>
  </span>
);
