import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { McpSegment } from './McpSegment';

describe('McpSegment keyboard navigation', () => {
  it('uses one tab stop and skips disabled choices with arrow keys', () => {
    const onChange = vi.fn();
    render(
      <McpSegment
        label="Machine"
        value="one"
        options={[
          { value: 'one', label: 'One', description: 'Online' },
          { value: 'offline', label: 'Offline', description: 'Unavailable', disabled: true },
          { value: 'two', label: 'Two', description: 'Online' },
        ]}
        onChange={onChange}
      />,
    );

    const one = screen.getByRole('radio', { name: /One/ });
    const two = screen.getByRole('radio', { name: /Two/ });
    expect(one).toHaveAttribute('tabindex', '0');
    expect(two).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(one, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('two');
    expect(two).toHaveFocus();
  });
});
