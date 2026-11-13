import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

interface ClaySelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  compact?: boolean;
  minWidth?: number;
}

export function ClaySelect({
  value,
  options,
  onChange,
  compact = false,
  minWidth = 140,
}: ClaySelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, []);

  const selected = options.find((o) => o.value === value) ?? options[0];

  return (
    <div
      ref={rootRef}
      className={`clay-select-root ${compact ? "compact" : ""}`}
      style={compact ? undefined : { minWidth }}
    >
      <button
        type="button"
        className={`clay-select-trigger ${compact ? "compact" : ""} ${open ? "open" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="clay-select-label">{selected?.label ?? value}</span>
        <ChevronDown
          size={compact ? 13 : 15}
          className={`clay-select-chevron ${open ? "rotated" : ""}`}
        />
      </button>

      {open && (
        <div className={`clay-select-menu ${compact ? "compact" : ""}`}>
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                className={`clay-select-item ${isSelected ? "selected" : ""}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span>{opt.label}</span>
                {isSelected && <Check size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

