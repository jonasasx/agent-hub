export interface McpSegmentOption<Value extends string> {
  value: Value;
  label: string;
  description: string;
  disabled?: boolean;
}

interface McpSegmentProps<Value extends string> {
  label: string;
  value: Value;
  options: McpSegmentOption<Value>[];
  onChange: (value: Value) => void;
}

export function McpSegment<Value extends string>({ label, value, options, onChange }: McpSegmentProps<Value>) {
  const enabledOptions = options.filter(option => !option.disabled);
  const tabStopValue = enabledOptions.some(option => option.value === value) ? value : enabledOptions[0]?.value;

  return (
    <div className="mcp-segment-field">
      <span className="lbl">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            className={`seg-opt${value === option.value ? ' on' : ''}`}
            disabled={option.disabled}
            tabIndex={option.value === tabStopValue ? 0 : -1}
            onKeyDown={event => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown' && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp') return;
              event.preventDefault();
              const currentIndex = enabledOptions.findIndex(item => item.value === option.value);
              if (currentIndex < 0) return;
              const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
              const nextIndex = (currentIndex + direction + enabledOptions.length) % enabledOptions.length;
              const nextOption = enabledOptions[nextIndex];
              if (nextOption) {
                onChange(nextOption.value);
                const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)');
                buttons?.[nextIndex]?.focus();
              }
            }}
            onClick={() => onChange(option.value)}
          >
            <b>{option.label}</b>
            <span>{option.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
