/**
 * SearchInput — debounced search input with clear button.
 */

import { useEffect, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Search, X } from 'lucide-react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
}

export const SearchInput = ({
  value,
  onChange,
  placeholder = 'Search...',
  debounceMs,
}: SearchInputProps): React.JSX.Element => {
  const [localValue, setLocalValue] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleChange = (next: string) => {
    setLocalValue(next);
    if (debounceMs && debounceMs > 0) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onChange(next), debounceMs);
    } else {
      onChange(next);
    }
  };

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
      <Input
        type="text"
        value={localValue}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        className="pl-9 pr-8"
      />
      {localValue && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => handleChange('')}
          className="absolute right-1 top-1/2 size-7 -translate-y-1/2"
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
};
