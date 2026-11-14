// Change desktop-download, Requirement: Приложение подключается к хабу, с которого скачано.
import { describe, expect, it } from 'vitest';
import { hubFromInstaller, installDecision } from './installSource.js';

const ZONE = (url: string) => `[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://x.example/\r\nHostUrl=${url}\r\n`;

describe('hubFromInstaller', () => {
  it('the tag of the file name: host, host_port, full path, a browser suffix', () => {
    expect(hubFromInstaller('Agent-Hub-Setup-0.1.8 [agents.example.org].exe', null)).toBe('https://agents.example.org');
    expect(hubFromInstaller('Agent-Hub-Setup-0.1.8 [hub.example.com_8443].exe', null)).toBe('https://hub.example.com:8443');
    expect(hubFromInstaller('C:\\Users\\u\\Downloads\\Agent-Hub-Setup-0.1.8 [Hub.Example.com].exe', null)).toBe('https://hub.example.com');
    expect(hubFromInstaller('Agent-Hub-Setup-0.1.8 [hub.example.com] (1).exe', null)).toBe('https://hub.example.com');
    expect(hubFromInstaller('/home/u/Downloads/Agent-Hub-0.1.9 [hub.example.com_8443].AppImage', null)).toBe('https://hub.example.com:8443');
    expect(hubFromInstaller('Agent-Hub-0.1.9.AppImage', null)).toBeNull();
  });

  it('the tag wins over Zone.Identifier', () => {
    const zone = ZONE('https://other.example/api/desktop/download');
    expect(hubFromInstaller('Agent-Hub-Setup-0.1.8 [hub.example.com].exe', zone)).toBe('https://hub.example.com');
  });

  it('no tag: HostUrl of the hub download', () => {
    expect(hubFromInstaller('setup.exe', ZONE('https://hub.example.com/api/desktop/download'))).toBe('https://hub.example.com');
    expect(hubFromInstaller('setup.exe', `\uFEFF${ZONE('https://hub.example.com:8443/api/desktop/download')}`)).toBe('https://hub.example.com:8443');
  });

  it('nothing known → null', () => {
    expect(hubFromInstaller('Agent-Hub-Setup-0.1.8.exe', null)).toBeNull();
    expect(hubFromInstaller('Agent-Hub-Setup-0.1.8 [bad host].exe', null)).toBeNull();
    expect(hubFromInstaller('Agent-Hub-Setup-0.1.8 [hub.example.com_99999].exe', null)).toBeNull();
    expect(hubFromInstaller('setup.exe', ZONE('https://github.com/x/releases/download/v1/setup.exe'))).toBeNull();
    expect(hubFromInstaller('setup.exe', ZONE('http://hub.example.com/api/desktop/download'))).toBeNull();
    expect(hubFromInstaller('setup.exe', 'garbage')).toBeNull();
  });
});

describe('installDecision', () => {
  const P = 'https://hub.example.com';
  it('unknown source or the same hub → none', () => {
    expect(installDecision(null, P, true, P)).toBe('none');
    expect(installDecision('https://a.example', 'https://a.example', false, P)).toBe('none');
  });
  it('a fresh install or the placeholder → apply', () => {
    expect(installDecision('https://a.example', 'https://b.example', true, P)).toBe('apply');
    expect(installDecision('https://a.example', P, false, P)).toBe('apply');
  });
  it('another hub already set → ask', () => {
    expect(installDecision('https://a.example', 'https://b.example', false, P)).toBe('ask');
  });
});
