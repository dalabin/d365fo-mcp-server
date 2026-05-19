import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks -----------------------------------------------------------
const {
  accessMock, writeFileMock, unlinkMock, readFileMock, readdirMock, spawnMock, execFileMock,
  cfgEnsureLoaded, cfgGetProjectPath, cfgGetPackagePath, cfgGetContext,
  cfgGetCustomPackagesPath, cfgGetMicrosoftPackagesPath,
} = vi.hoisted(() => {
  const accessMock = vi.fn();
  const writeFileMock = vi.fn().mockResolvedValue(undefined);
  const unlinkMock = vi.fn().mockResolvedValue(undefined);
  const readFileMock = vi.fn();
  const readdirMock = vi.fn().mockRejectedValue(new Error('not found'));
  const spawnMock = vi.fn();
  // execFile needs to call its callback for util.promisify to work
  const execFileMock: any = vi.fn((_file: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout: '', stderr: '' });
  });
  const cfgEnsureLoaded = vi.fn();
  const cfgGetProjectPath = vi.fn().mockResolvedValue('C:\\MyProject\\MyProject.rnrproj');
  const cfgGetPackagePath = vi.fn().mockReturnValue(null);
  const cfgGetContext = vi.fn().mockReturnValue({});
  const cfgGetCustomPackagesPath = vi.fn().mockResolvedValue(null);
  const cfgGetMicrosoftPackagesPath = vi.fn().mockResolvedValue(null);
  return {
    accessMock, writeFileMock, unlinkMock, readFileMock, readdirMock, spawnMock, execFileMock,
    cfgEnsureLoaded, cfgGetProjectPath, cfgGetPackagePath, cfgGetContext,
    cfgGetCustomPackagesPath, cfgGetMicrosoftPackagesPath,
  };
});

vi.mock('child_process', () => ({ spawn: spawnMock, execFile: execFileMock }));
vi.mock('fs', () => ({
  openSync: vi.fn().mockReturnValue(3),
  closeSync: vi.fn(),
}));
vi.mock('fs/promises', () => ({
  access: accessMock,
  writeFile: writeFileMock,
  unlink: unlinkMock,
  readFile: readFileMock,
  appendFile: vi.fn().mockResolvedValue(undefined),
  readdir: readdirMock,
}));
vi.mock('../../src/utils/configManager.js', () => ({
  getConfigManager: () => ({
    ensureLoaded: cfgEnsureLoaded,
    getProjectPath: cfgGetProjectPath,
    getPackagePath: cfgGetPackagePath,
    getContext: cfgGetContext,
    getCustomPackagesPath: cfgGetCustomPackagesPath,
    getMicrosoftPackagesPath: cfgGetMicrosoftPackagesPath,
  }),
}));
vi.mock('../../src/utils/operationLocks.js', () => ({
  withOperationLock: (_key: string, fn: () => any) => fn(),
  isOperationLockHeld: vi.fn().mockResolvedValue(false),
  forceReleaseLock: vi.fn().mockResolvedValue(undefined),
}));

import path from 'path';
import { buildProjectTool } from '../../src/tools/buildProject';

const PROJECT_PATH = 'C:\\MyProject\\MyProject.rnrproj';
const MODEL_NAME = 'MyModel';
const RNRPROJ_XML = `<Project><Model>${MODEL_NAME}</Model></Project>`;
const PKG = 'C:\\AOSService\\PackagesLocalDirectory';
const XPPC = path.join(PKG, 'bin', 'xppc.exe');

function makeFakeChild(pid = 12345) {
  const child: any = {
    pid,
    unref: vi.fn(),
    on: vi.fn(),
  };
  return child;
}

/** accessMock passes only listed paths */
function allowPaths(paths: string[]) {
  accessMock.mockImplementation(async (p: string) => {
    if (paths.some(allowed => p === allowed || p.replace(/\\/g, '/') === allowed.replace(/\\/g, '/'))) return;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  });
}

describe('build_d365fo_project', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    writeFileMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    readdirMock.mockRejectedValue(new Error('not found'));
    cfgGetProjectPath.mockResolvedValue(PROJECT_PATH);
    cfgGetPackagePath.mockReturnValue(null);
    cfgGetContext.mockReturnValue({});
    cfgGetCustomPackagesPath.mockResolvedValue(null);
    cfgGetMicrosoftPackagesPath.mockResolvedValue(null);
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, cb: Function) => {
      cb(null, { stdout: '', stderr: '' });
    });
    // By default no state file exists
    readFileMock.mockImplementation(async (p: string) => {
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  it('starts a background xppc.exe build and returns started message', async () => {
    const child = makeFakeChild(42);
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, XPPC, PKG]);

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [exe, args] = spawnMock.mock.calls[0];
    expect(exe).toBe(XPPC);
    expect(args).toContain(`-metadata=${PKG}`);
    expect(args).toContain(`-modelmodule=${MODEL_NAME}`);
    expect(result.content[0].text).toContain('Build started');
    expect(result.isError).toBeFalsy();
  });

  it('writes a build state file when launching xppc.exe', async () => {
    const child = makeFakeChild(99);
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, XPPC, PKG]);

    await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    // writeFile is called to persist build state JSON
    const stateCall = writeFileMock.mock.calls.find((c: any[]) => c[0].includes('d365build_state'));
    expect(stateCall).toBeDefined();
    const state = JSON.parse(stateCall![1]);
    expect(state.pid).toBe(99);
    expect(state.status).toBe('running');
    expect(state.tool).toBe('xppc.exe');
  });

  it('calls child.unref() to prevent blocking server shutdown', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, XPPC, PKG]);

    await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('returns error when packages path cannot be resolved', async () => {
    // No CHE candidates accessible, no configManager paths
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot resolve D365FO package paths');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns error when xppc.exe is not found', async () => {
    // PKG dir exists but xppc.exe does not
    allowPaths([PROJECT_PATH, PKG]);

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('xppc.exe');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns error when project path is missing', async () => {
    cfgGetProjectPath.mockResolvedValue('');

    const result = await buildProjectTool({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot determine project path');
  });

  it('returns in-progress status when build is already running', async () => {
    const stateJson = JSON.stringify({
      pid: 777,
      projectPath: PROJECT_PATH,
      tool: 'xppc.exe',
      startTime: new Date().toISOString(),
      logFile: 'C:\\Temp\\d365build_log_abc.log',
      status: 'running',
    });
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) return stateJson;
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      if (p.includes('d365build_log')) return 'Compiling...';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // Simulate PID 777 being alive via process.kill mock
    const origKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid: any, sig: any) => {
      if (pid === 777 && sig === 0) return true as any;
      return origKill(pid, sig);
    });

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(result.content[0].text).toContain('in progress');
    expect(spawnMock).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('returns succeeded result when previous build finished successfully', async () => {
    const stateJson = JSON.stringify({
      pid: 888,
      projectPath: PROJECT_PATH,
      tool: 'xppc.exe',
      startTime: new Date(Date.now() - 30_000).toISOString(),
      endTime: new Date().toISOString(),
      logFile: 'C:\\Temp\\d365build_log_xyz.log',
      status: 'succeeded',
      exitCode: 0,
    });
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) return stateJson;
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      if (p.includes('d365build_log')) return 'Build complete.';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(result.content[0].text).toContain('succeeded');
    expect(result.isError).toBeFalsy();
    expect(spawnMock).not.toHaveBeenCalled();
    // State file should be cleared
    expect(unlinkMock).toHaveBeenCalled();
  });

  it('returns error result when previous build failed', async () => {
    const stateJson = JSON.stringify({
      pid: 999,
      projectPath: PROJECT_PATH,
      tool: 'xppc.exe',
      startTime: new Date(Date.now() - 60_000).toISOString(),
      endTime: new Date().toISOString(),
      logFile: 'C:\\Temp\\d365build_log_fail.log',
      status: 'failed',
      exitCode: 1,
    });
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) return stateJson;
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      if (p.includes('d365build_log')) return 'error AX0001: Something broke';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('FAILED');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('passes -metadata and -compilermetadata args to xppc.exe', async () => {
    const CUSTOM = 'C:\\Repos\\MyCode\\Metadata';
    const MSFT = 'C:\\AOSService\\PackagesLocalDirectory';
    const xppc = path.join(MSFT, 'bin', 'xppc.exe');

    cfgGetCustomPackagesPath.mockResolvedValue(CUSTOM);
    cfgGetMicrosoftPackagesPath.mockResolvedValue(MSFT);

    const child = makeFakeChild(55);
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, xppc]);

    await buildProjectTool({ projectPath: PROJECT_PATH }, {});

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain(`-metadata=${CUSTOM}`);
    expect(args).toContain(`-compilermetadata=${MSFT}`);
    expect(args).toContain(`-modelmodule=${MODEL_NAME}`);
  });

  it('force=true kills orphaned build and restarts', async () => {
    const stateJson = JSON.stringify({
      pid: 1234,
      projectPath: PROJECT_PATH,
      tool: 'xppc.exe',
      startTime: new Date().toISOString(),
      logFile: 'C:\\Temp\\d365build_log_old.log',
      status: 'running',
    });
    readFileMock.mockImplementation(async (p: string) => {
      if (p.includes('d365build_state')) return stateJson;
      if (p.endsWith('.rnrproj')) return RNRPROJ_XML;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const child = makeFakeChild(5678);
    spawnMock.mockReturnValue(child);
    allowPaths([PROJECT_PATH, XPPC, PKG]);

    const result = await buildProjectTool({ projectPath: PROJECT_PATH, force: true }, {});

    // A new build was started
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Build started');
  });
});
