import { describe, expect, it } from 'vitest';
import registrySource from './McpRegistry.tsx?raw';
import registryListSource from './McpRegistryList.tsx?raw';
import serverFormSource from './McpServerForm.tsx?raw';
import viewsSource from './McpViews.tsx?raw';
import wizardSource from './McpWizard.tsx?raw';

describe('MCP control styling', () => {
  it('uses shared input classes for fields and an explicit class for checkboxes', () => {
    const sources: Record<string, string> = {
      'McpRegistry.tsx': registrySource,
      'McpRegistryList.tsx': registryListSource,
      'McpServerForm.tsx': serverFormSource,
      'McpViews.tsx': viewsSource,
      'McpWizard.tsx': wizardSource,
    };
    const controls: Array<{ file: string; tag: string; attributes: string }> = [];

    for (const [file, source] of Object.entries(sources)) {
      const matches = source.matchAll(/<(select|textarea|input)\b([^>]*)>/gs);
      for (const match of matches) {
        controls.push({ file, tag: match[1] ?? '', attributes: match[2] ?? '' });
      }
    }

    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const isCheckbox = control.tag === 'input' && /\btype=["']checkbox["']/.test(control.attributes);
      if (isCheckbox) {
        expect(control.attributes, `${control.file} checkbox`).toMatch(/\bclassName=["']mcp-checkbox["']/);
      } else {
        expect(control.attributes, `${control.file} ${control.tag}`).toMatch(/\bclassName=["']input(?:\s|["'])/);
      }
    }
  });
});
