import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..', '..');
const frontendDir = join(projectRoot, 'frontend');
const backendDir = join(projectRoot, 'backend');
const syntheticProfile = {
  academic_background: 'Synthetic Grade 12 science background.',
  stream: 'Science',
  board: 'CBSE',
  academic_score: 88.4,
  exam_scores: { CUET: 91.2 },
  budget: 420000,
  career_goal: 'Biotechnology research',
  interests: ['biology', 'chemistry'],
  preferred_courses: ['BSc Biotechnology'],
  missing_information: ['preferred location'],
  clarification_questions: ['Which city do you prefer?'],
};

let passed = 0;
const children = [];

function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`PASS ${message}`);
}

function assertLoopbackUrl(value, description) {
  const url = new URL(value);
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    `${description} must use a loopback host.`,
  );
  assert.ok(
    ['http:', 'ws:', 'mongodb:', 'redis:'].includes(url.protocol),
    `${description} must use a local service protocol.`,
  );
}

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return port;
}

function startProcess(command, args, options = {}) {
  const { label = command, ...spawnOptions } = options;
  const child = spawn(command, args, {
    ...spawnOptions,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.label = label;
  child.outputTail = '';
  child.on('error', (error) => {
    child.startError = error;
  });
  const captureOutput = (chunk) => {
    child.outputTail = `${child.outputTail}${chunk.toString()}`.slice(-8000);
  };
  child.stdout.on('data', captureOutput);
  child.stderr.on('data', captureOutput);
  children.push(child);
  return child;
}

async function waitForHttp(url, child, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.startError) {
      throw new Error(`${description} failed to start: ${child.startError.message}`);
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`${description} exited before becoming ready.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local service may not be listening yet.
    }
    await delay(200);
  }
  throw new Error(`${description} did not become ready in time.`);
}

async function waitForTestBackend(url, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.startError) {
      throw new Error(`Backend failed to start: ${child.startError.message}`);
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error('Backend exited before becoming ready.');
    }
    let response;
    try {
      response = await fetch(url);
    } catch {
      await delay(200);
      continue;
    }
    const health = await response.json();
    assert.equal(response.status, 200, 'Test backend health check failed.');
    assert.equal(health.status, 'ok', 'Test backend is not healthy.');
    assert.equal(health.storage_backend, 'demo', 'Test backend did not use explicit demo storage.');
    return health;
  }
  throw new Error('Backend did not become ready in time.');
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([once(child, 'exit').catch(() => undefined), delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit').catch(() => undefined), delay(1000)]);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, `Could not stop test process: ${child.label}`);
}

function createOllamaStub() {
  let available = true;
  let chatRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.writeHead(available ? 200 : 503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(available ? { models: [{ name: 'synthetic-e2e-model' }] } : { error: 'synthetic unavailable' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/chat') {
      let requestBody = '';
      for await (const _chunk of request) {
        requestBody += _chunk.toString();
      }
      chatRequests += 1;
      let content;
      const requestPayload = JSON.parse(requestBody);
      if (requestPayload.messages?.some((message) => message.content === 'Reply with exactly: OLLAMA_STATUS_OK')) {
        content = 'OLLAMA_STATUS_OK';
      } else if (requestBody.includes('Create exactly one concise interview-practice question')) {
        content = JSON.stringify({
          question: 'What synthetic project would you explore in the Data Science program?',
        });
      } else if (requestBody.includes('Evaluate only the submitted answers')) {
        content = JSON.stringify({
          summary: 'The synthetic answer is a concrete practice example.',
          dimensions: [
            {
              dimension: 'relevance',
              score: 4,
              explanation: 'The answer directly mentions a project and data.',
              evidence: 'Synthetic practice answer',
            },
            {
              dimension: 'clarity',
              score: 4,
              explanation: 'The answer is concise and understandable.',
              evidence: 'Synthetic practice answer',
            },
            {
              dimension: 'reasoning',
              score: 3,
              explanation: 'The answer could make its reason more explicit.',
              evidence: 'Synthetic practice answer',
            },
            {
              dimension: 'completeness',
              score: 3,
              explanation: 'The answer could include an outcome or reflection.',
              evidence: 'Synthetic practice answer',
            },
          ],
        });
      } else if (requestBody.includes('You are Admission AI Assistant')) {
        content = 'This uploaded record is not independently verified; no current eligibility criteria are available.';
      } else {
        content = JSON.stringify(syntheticProfile);
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        model: 'synthetic-e2e-model',
        message: { content },
        done: true,
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return {
    server,
    setAvailable(value) {
      available = value;
    },
    get chatRequests() {
      return chatRequests;
    },
  };
}

class DevToolsClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', () => rejectOpen(new Error('Could not connect to Chrome DevTools.')), { once: true });
    });
    return new DevToolsClient(socket);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`Chrome DevTools command timed out: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitForPage(client, expression, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await client.evaluate(expression);
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForRequest(request, description) {
  const deadline = Date.now() + 10000;
  while (!request.finished && Date.now() < deadline) await delay(50);
  assert.equal(request.finished, true, `${description} did not finish.`);
}

async function fill(client, selector, value) {
  const result = await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing input: ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set;
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(result, true);
}

async function clickButton(client, label) {
  const result = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button) throw new Error('Missing button: ' + ${JSON.stringify(label)});
    if (button.disabled) throw new Error('Button is disabled: ' + ${JSON.stringify(label)});
    button.click();
    return true;
  })()`);
  assert.equal(result, true);
}

async function browserFetch(client, expression) {
  return client.evaluate(`(async () => {
    const result = await (${expression});
    return result;
  })()`);
}

async function main() {
  Object.assign(process.env, {
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '*',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    no_proxy: '*',
  });
  const apiPort = await getFreePort();
  const frontendPort = await getFreePort();
  const ollamaPort = await getFreePort();
  const debuggingPort = await getFreePort();
  const apiBase = `http://127.0.0.1:${apiPort}/api`;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const ollamaBaseUrl = `http://127.0.0.1:${ollamaPort}`;
  const debuggingUrl = `http://127.0.0.1:${debuggingPort}`;
  const mongoGuardUrl = 'mongodb://127.0.0.1:1/uniapply_browser_guard';
  const redisUrl = 'redis://127.0.0.1:6379/0';
  const ollama = createOllamaStub();
  const testTempDir = mkdtempSync(join(tmpdir(), 'uniapply-student-journey-'));
  const chromeProfile = join(testTempDir, 'chrome-profile');
  const downloadDir = join(testTempDir, 'downloads');
  let browser;
  let devTools;
  let backend;
  let frontend;

  try {
    mkdirSync(chromeProfile);
    mkdirSync(downloadDir);
    assertLoopbackUrl(apiBase, 'Backend API URL');
    assertLoopbackUrl(frontendUrl, 'Frontend URL');
    assertLoopbackUrl(ollamaBaseUrl, 'Ollama stub URL');
    assertLoopbackUrl(debuggingUrl, 'Chrome DevTools URL');
    assertLoopbackUrl(mongoGuardUrl, 'MongoDB guard URL');
    assertLoopbackUrl(redisUrl, 'Redis URL');

    await new Promise((resolveListen, rejectListen) => {
      ollama.server.once('error', rejectListen);
      ollama.server.listen(ollamaPort, '127.0.0.1', resolveListen);
    });

    backend = startProcess(
      process.env.PYTHON || 'python',
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(apiPort), '--no-access-log'],
      {
        label: 'Backend',
        cwd: testTempDir,
        env: {
          ...process.env,
          APP_ENV: 'development',
          STORAGE_BACKEND: 'demo',
          PYTHONPATH: backendDir,
          CORS_ORIGINS: frontendUrl,
          JWT_SECRET_KEY: randomBytes(32).toString('hex'),
          LLM_PROVIDER: 'ollama',
          LLM_MODEL: 'synthetic-e2e-model',
          OLLAMA_MODEL: 'synthetic-e2e-model',
          OLLAMA_BASE_URL: ollamaBaseUrl,
          LLM_TIMEOUT_SECONDS: '3',
          LLM_MAX_RETRIES: '0',
          MONGODB_URI: mongoGuardUrl,
          REDIS_URL: redisUrl,
        },
      },
    );
    const viteCli = join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');
    const viteEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_')),
    );
    viteEnv.VITE_API_BASE_URL = apiBase;
    viteEnv.UNIAPPLY_VITE_ENV_DIR = testTempDir;
    frontend = startProcess(
      process.execPath,
      [viteCli, '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'],
      { label: 'Frontend', cwd: frontendDir, env: viteEnv },
    );

    const health = await waitForTestBackend(`${apiBase}/health`, backend);
    await waitForHttp(frontendUrl, frontend, 'Frontend');
    check(health.status === 'ok' && health.storage_backend === 'demo', 'browser journey uses only the isolated in-memory test store');

    const chromeCandidates = [
      process.env.CHROME_PATH,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean);
    const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
    if (!chromePath) throw new Error('Chrome or Edge is required; set CHROME_PATH to its executable.');

    browser = startProcess(
      chromePath,
      [
        '--headless=new',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-proxy-server',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        '--remote-allow-origins=*',
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${debuggingPort}`,
        `--user-data-dir=${chromeProfile}`,
        'about:blank',
      ],
      { env: { ...process.env } },
    );
    const versionUrl = `${debuggingUrl}/json/version`;
    await waitForHttp(versionUrl, browser, 'Chrome');
    const targetResponse = await fetch(
      `${debuggingUrl}/json/new?${encodeURIComponent(frontendUrl)}`,
      { method: 'PUT' },
    );
    assert.equal(targetResponse.ok, true, 'Chrome did not create a page target.');
    const target = await targetResponse.json();
    assertLoopbackUrl(target.webSocketDebuggerUrl, 'Chrome DevTools WebSocket URL');
    devTools = await DevToolsClient.connect(target.webSocketDebuggerUrl);
    await devTools.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
    });

    const apiRequests = new Map();
    devTools.on('Network.requestWillBeSent', (event) => {
      const url = new URL(event.request.url);
      if (!url.pathname.startsWith('/api/')) return;
      apiRequests.set(event.requestId, {
        url: event.request.url,
        path: url.pathname,
        method: event.request.method,
        postData: event.request.postData ?? '',
        headers: event.request.headers,
        status: null,
        finished: false,
      });
    });
    devTools.on('Network.responseReceived', (event) => {
      const request = apiRequests.get(event.requestId);
      if (request) request.status = event.response.status;
    });
    devTools.on('Network.loadingFinished', (event) => {
      const request = apiRequests.get(event.requestId);
      if (request) request.finished = true;
    });
    await devTools.send('Network.enable');
    await devTools.send('Page.enable');
    await devTools.send('Runtime.enable');
    await devTools.send('Page.navigate', { url: frontendUrl });

    const initialAuth = await waitForPage(
      devTools,
      `(() => document.querySelector('input[type="email"]') && document.querySelector('input[type="email"]').value === '' && document.querySelector('input[type="password"]').value === '' && sessionStorage.getItem('uniapply-token') === null)()`,
      'the blank sign-in page',
    );
    check(initialAuth, 'application opens with blank credentials and no saved session');

    const syntheticTag = randomUUID().replaceAll('-', '').slice(0, 12);
    const email = `student-${syntheticTag}@example.com`;
    const password = `Synthetic-${randomBytes(12).toString('hex')}!`;
    await clickButton(devTools, 'New student? Create an account');
    await fill(devTools, 'input:not([type]), input[type="text"]', 'Synthetic Student');
    await fill(devTools, 'input[type="email"]', email);
    await fill(devTools, 'input[type="password"]', password);
    await clickButton(devTools, 'Create student account');
    await waitForPage(devTools, `document.body.innerText.includes('Student dashboard')`, 'the student dashboard');
    await devTools.evaluate(`location.hash = 'profile';`);
    await waitForPage(devTools, `document.body.innerText.includes('AI profile intake')`, 'the profile and documents page');
    await clickButton(devTools, 'System status');
    await waitForPage(devTools, `document.body.innerText.includes('AI provider') && document.body.innerText.includes('OLLAMA CONNECTED')`, 'the authenticated AI status');
    check(true, 'synthetic student registration authenticates and opens the dashboard');

    const statusText = await devTools.evaluate(`document.body.innerText`);
    const statusRequestEntry = [...apiRequests.entries()].find(([, request]) => request.path === '/api/ai/status' && request.method === 'GET');
    assert.ok(statusRequestEntry, 'The dashboard did not call GET /api/ai/status.');
    const [statusRequestId, statusRequest] = statusRequestEntry;
    const statusAuthorization = Object.entries(statusRequest.headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
    assert.match(statusAuthorization ?? '', /^Bearer /);
    await waitForRequest(statusRequest, 'The authenticated AI status request');
    const statusPayload = JSON.parse((await devTools.send('Network.getResponseBody', { requestId: statusRequestId })).body);
    assert.equal(statusRequest.status, 200);
    assert.equal(statusPayload.active_provider, 'ollama');
    assert.equal(statusPayload.profile_intake_enabled, true);
    assert.equal(statusPayload.fallback_active, false);
    check(
      statusText.includes('AI provider') &&
        statusText.includes('OLLAMA CONNECTED · Model: synthetic-e2e-model · Mode: Local AI'),
      'authenticated AI status matches the configured local Ollama provider',
    );

    const apiOrigin = JSON.stringify(apiBase);
    const profileBefore = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/profile', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('uniapply-token') } }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
    );
    assert.equal(profileBefore.status, 200);

    const description = 'I completed Grade 12 science, enjoy biology and chemistry, prefer biotechnology, and have a budget of 420000.';
    await fill(devTools, '#profile-intake-description', description);
    const enteredDescription = await devTools.evaluate(`document.querySelector('#profile-intake-description').value`);
    assert.equal(enteredDescription, description, 'The browser did not enter the intake description.');
    await clickButton(devTools, 'Extract profile for review');
    await waitForPage(devTools, `document.body.innerText.includes('Model-generated by ollama (synthetic-e2e-model). Not saved yet.')`, 'the structured intake review');

    const intakeRequests = [...apiRequests.values()].filter(
      (request) => request.path === '/api/profile/intake' && request.method === 'POST',
    );
    const intakeRequest = intakeRequests.at(-1);
    assert.ok(intakeRequest, 'The browser did not call POST /api/profile/intake.');
    assert.equal(JSON.parse(intakeRequest.postData).description, description);
    const contentType = Object.entries(intakeRequest.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
    assert.match(contentType ?? '', /^application\/json\b/i);
    const responseDeadline = Date.now() + 10000;
    while (intakeRequest.status === null && Date.now() < responseDeadline) {
      await delay(50);
    }
    assert.equal(intakeRequest.status, 200, 'The profile intake endpoint did not return HTTP 200.');
    const intakeRequestId = [...apiRequests.entries()].find(([, request]) => request === intakeRequest)[0];
    await waitForRequest(intakeRequest, 'The profile intake response');
    const responseBody = await devTools.send('Network.getResponseBody', { requestId: intakeRequestId });
    const intakeResponse = JSON.parse(responseBody.body);
    assert.deepEqual(
      Object.keys(intakeResponse.profile).sort(),
      ['academic_background', 'academic_score', 'board', 'budget', 'career_goal', 'clarification_questions', 'exam_scores', 'interests', 'missing_information', 'preferred_courses', 'stream'].sort(),
    );
    assert.equal(intakeResponse.status, 'model_generated');
    assert.equal(intakeResponse.provider, 'ollama');
    assert.equal(intakeResponse.persisted, false);
    assert.equal(intakeResponse.profile.academic_score, 88.4);
    assert.deepEqual(intakeResponse.profile.interests, ['biology', 'chemistry']);
    assert.deepEqual(intakeResponse.profile.preferred_courses, ['BSc Biotechnology']);
    const profileAfterExtraction = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/profile', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('uniapply-token') } }).then((response) => response.json())`,
    );
    check(
      intakeResponse.profile.budget === 420000 &&
        JSON.stringify(profileAfterExtraction) === JSON.stringify(profileBefore.body) &&
        ollama.chatRequests === 2,
      'intake reaches the backend, returns validated structured data, and does not auto-save',
    );

    const extractedCareerGoal = await devTools.evaluate(`document.querySelector('[aria-label="Review career goal"]').value`);
    assert.equal(extractedCareerGoal, syntheticProfile.career_goal);
    await fill(devTools, '[aria-label="Review career goal"]', 'Synthetic computational biology research');
    const reviewedGoal = await devTools.evaluate(`document.querySelector('[aria-label="Review career goal"]').value`);
    assert.equal(reviewedGoal, 'Synthetic computational biology research');
    await clickButton(devTools, 'Apply these reviewed fields to my profile');
    await waitForPage(devTools, `document.body.innerText.includes('Reviewed fields saved')`, 'the explicit save confirmation');
    const savedProfile = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/profile', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('uniapply-token') } }).then((response) => response.json())`,
    );
    assert.equal(savedProfile.career_goal, reviewedGoal);
    assert.equal(savedProfile.budget, 420000);
    assert.deepEqual(savedProfile.interests, ['biology', 'chemistry']);
    assert.deepEqual(savedProfile.preferred_fields, ['BSc Biotechnology']);
    assert.ok(savedProfile.notes.includes(syntheticProfile.academic_background));
    await devTools.send('Page.reload');
    await waitForPage(devTools, `document.body.innerText.includes('Profile & Documents')`, 'the reloaded profile page');
    await waitForPage(
      devTools,
      `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Extract profile for review' && !button.disabled)`,
      'the ready intake form after reload',
    );
    const reloadedProfile = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/profile', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('uniapply-token') } }).then((response) => response.json())`,
    );
    check(
      reloadedProfile.career_goal === reviewedGoal &&
        reloadedProfile.budget === 420000 &&
        JSON.stringify(reloadedProfile.interests) === JSON.stringify(['biology', 'chemistry']) &&
        JSON.stringify(reloadedProfile.preferred_fields) === JSON.stringify(['BSc Biotechnology']),
      'edited fields persist after an explicit apply and page reload',
    );

    const eligibilityResponse = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/eligibility', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('uniapply-token') } }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
    );
    assert.equal(eligibilityResponse.status, 200);
    assert.ok(eligibilityResponse.body.length > 0, 'No synthetic programs were available for the allocation journey.');
    await devTools.evaluate(`location.hash = 'applications';`);
    await waitForPage(
      devTools,
      `document.body.innerText.includes('No currently eligible program has institution-supplied verified application details.')`,
      'the fail-closed applications page',
    );
    check(true, 'illustrative criteria do not fabricate application opportunities');
    const exploreDirectoryResponse = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/explore/colleges', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('uniapply-token') } }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
    );
    assert.equal(exploreDirectoryResponse.status, 200);
    assert.equal(exploreDirectoryResponse.body.total, 732);
    assert.ok(exploreDirectoryResponse.body.colleges.some((college) => college.ug_fee !== null));
    assert.ok(exploreDirectoryResponse.body.colleges.some((college) => college.rating !== null));
    assert.ok(exploreDirectoryResponse.body.colleges.every((college) => college.application_links.length === 0));
    await devTools.evaluate(`location.hash = 'explore';`);
    await waitForPage(
      devTools,
      `document.body.innerText.includes('Explore & Apply') && document.body.innerText.includes('Official Application Link Not Available')`,
      'the source-backed Explore & Apply directory',
    );
    await waitForPage(
      devTools,
      `document.body.innerText.includes('732') && document.querySelectorAll('.explore-college-card').length === 9`,
      'the uploaded dataset records and rendered first page',
    );
    const firstDirectoryCollege = exploreDirectoryResponse.body.colleges[0];
    const firstDirectoryCardText = await devTools.evaluate(`document.querySelector('.explore-college-card').innerText`);
    assert.ok(firstDirectoryCardText.includes(firstDirectoryCollege.name));
    if (firstDirectoryCollege.state) assert.ok(firstDirectoryCardText.includes(firstDirectoryCollege.state));
    if (firstDirectoryCollege.rating !== null) assert.ok(firstDirectoryCardText.includes(String(firstDirectoryCollege.rating)));
    if (firstDirectoryCollege.ug_fee) assert.ok(firstDirectoryCardText.includes(firstDirectoryCollege.ug_fee));
    const exploreCardSummary = await devTools.evaluate(`({
      count: document.querySelectorAll('.explore-college-card').length,
      unavailableLinks: document.querySelectorAll('.explore-apply-unavailable').length,
      detailButton: Boolean([...document.querySelectorAll('.explore-college-card button')].find((button) => button.textContent.trim() === 'View details')),
    })`);
    assert.equal(exploreCardSummary.count, 9);
    assert.equal(exploreCardSummary.unavailableLinks, 9);
    assert.equal(exploreCardSummary.detailButton, true);
    await devTools.evaluate(`document.querySelector('.explore-favorite-button').click();`);
    await devTools.evaluate(`document.querySelector('.explore-view-tabs button:nth-child(2)').click();`);
    await waitForPage(devTools, `document.body.innerText.includes('My Saved Colleges')`, 'the saved college view');
    assert.equal(await devTools.evaluate(`document.querySelectorAll('.explore-college-card').length`), 1);
    await clickButton(devTools, 'View details');
    await waitForPage(
      devTools,
      `Boolean(document.querySelector('.explore-modal')) && document.body.innerText.includes('Historical cutoff information')`,
      'the college details view',
    );
    await devTools.evaluate(`document.querySelector('[aria-label="Close college details"]').click();`);
    await devTools.evaluate(`document.querySelector('.explore-compare-toggle input').click();`);
    await waitForPage(devTools, `document.body.innerText.includes('Compare selected colleges')`, 'the college comparison');
    check(true, 'Explore & Apply loads all uploaded colleges, keeps missing links unavailable, and supports details, favorites, and comparison');

    const rankedCollege = exploreDirectoryResponse.body.colleges.find((college) => (
      college.historical_cutoffs.some((cutoff) => (
        ['MHT-CET', 'JEE Main'].includes(cutoff.exam)
        && cutoff.category
        && cutoff.historical_closing_rank !== null
      ))
    ));
    assert.ok(rankedCollege, 'No college had a comparable historical cutoff for the AI predictor journey.');
    const rankedCutoff = rankedCollege.historical_cutoffs.find((cutoff) => (
      ['MHT-CET', 'JEE Main'].includes(cutoff.exam)
      && cutoff.category
      && cutoff.historical_closing_rank !== null
    ));
    const rankKey = rankedCutoff.exam === 'MHT-CET' ? 'MHT-CET' : 'JEE Main';
    const profileUpdate = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/profile', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + sessionStorage.getItem('uniapply-token'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          exam_ranks: { [${JSON.stringify(rankKey)}]: 1 },
          reservation_category: ${JSON.stringify(rankedCutoff.category)},
          preferred_fields: [${JSON.stringify(rankedCutoff.course)}],
        }),
      }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
    );
    assert.equal(profileUpdate.status, 200);
    await devTools.send('Page.reload');
    await waitForPage(devTools, `document.body.innerText.includes('Explore & Apply')`, 'the refreshed student profile');
    await devTools.evaluate(`location.hash = 'ai-predictor';`);
    await waitForPage(devTools, `Boolean(document.querySelector('.ai-predictor-hero'))`, 'the AI College Predictor page');
    await waitForPage(
      devTools,
      `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Generate recommendations' && !button.disabled)`,
      'the ready AI recommendation controls',
    );
    await clickButton(devTools, 'Generate recommendations');
    await waitForPage(devTools, `document.querySelectorAll('.ai-predictor-card').length > 0`, 'historical-rank recommendations');
    await clickButton(devTools, '♡ Save college');
    await waitForPage(devTools, `document.body.innerText.includes('Saved colleges')`, 'the saved AI college shortlist');
    await clickButton(devTools, 'Why this college?');
    await waitForPage(devTools, `Boolean(document.querySelector('.ai-chat-panel'))`, 'the context-aware admission chatbot');
    await fill(devTools, '#ai-chat-input', 'Which information about this college is verified?');
    await clickButton(devTools, 'Send');
    await waitForPage(
      devTools,
      `document.body.innerText.includes('This uploaded record is not independently verified')`,
      'the source-grounded chatbot answer',
    );
    assert.ok(await devTools.evaluate(`document.querySelectorAll('.ai-chat-sources').length > 0`));
    check(true, 'AI predictor saves rank-based results and favorites, and the local admission chatbot cites college context');
    await devTools.evaluate(`document.querySelector('.ai-chat-close').click();`);

    await devTools.evaluate(`location.hash = 'eligibility';`);
    await waitForPage(
      devTools,
      `Boolean(document.querySelector('#mhtcet-category option[value="General/Open"]'))`,
      'the MHT-CET recommendation filters',
    );
    await fill(devTools, '#mhtcet-rank', '11243');
    await fill(devTools, '#mhtcet-branch', 'Computer Science and Engineering');
    await fill(devTools, '#mhtcet-city', 'Amravati');
    await fill(devTools, '#mhtcet-category', 'General/Open');
    await fill(devTools, '#mhtcet-cap-round', '3');
    await devTools.evaluate(`(() => {
      window.__mhtcetOriginalFetch = window.fetch.bind(window);
      window.fetch = (...args) => String(args[0]).includes('/recommendations/mhtcet')
        ? new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({
          detail: 'Synthetic MHT-CET test error',
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })), 500))
        : window.__mhtcetOriginalFetch(...args);
    })()`);
    await clickButton(devTools, 'Search recommendations');
    await waitForPage(
      devTools,
      `document.body.innerText.includes('Searching historical cutoffs…')`,
      'the MHT-CET loading state',
    );
    check(true, 'MHT-CET search exposes a loading state');
    await waitForPage(
      devTools,
      `document.body.innerText.includes('Synthetic MHT-CET test error')`,
      'the MHT-CET request error state',
    );
    check(true, 'MHT-CET request failures are displayed to the student');
    await devTools.evaluate(`window.fetch = window.__mhtcetOriginalFetch; delete window.__mhtcetOriginalFetch;`);
    await clickButton(devTools, 'Search recommendations');
    await waitForPage(
      devTools,
      `document.body.innerText.includes('Government College of Engineering, Amravati') && document.body.innerText.includes('Historical closing rank: 11,243')`,
      'the MHT-CET historical cutoff result',
    );
    const mhtcetText = await devTools.evaluate('document.body.innerText');
    check(
      mhtcetText.includes('Within historical cutoff') &&
        mhtcetText.includes('secondary unverified') &&
        mhtcetText.includes('do not guarantee admission'),
      'MHT-CET results show historical rank comparison, provenance, and disclaimer',
    );
    await fill(devTools, '#mhtcet-branch', 'Computer Engineering');
    await fill(devTools, '#mhtcet-city', 'Mumbai');
    await fill(devTools, '#mhtcet-cap-round', '4');
    await clickButton(devTools, 'Search recommendations');
    await waitForPage(
      devTools,
      `document.body.innerText.includes('No comparable historical cutoff rows match the selected filters.') && document.body.innerText.includes('Clear branch filter (7)')`,
      'dataset-backed MHT-CET filter suggestions',
    );
    check(true, 'an empty MHT-CET filter combination offers actual dataset alternatives');
    await clickButton(devTools, 'Clear branch filter (7)');
    await waitForPage(
      devTools,
      `document.body.innerText.includes('7 matching historical records') && document.querySelector('#mhtcet-branch').value === ''`,
      'the broadened MHT-CET dataset results',
    );
    check(true, 'relaxing a filter displays matching historical records and updates the filter');
    await devTools.evaluate(`location.hash = 'allocation';`);
    await waitForPage(devTools, `document.body.innerText.includes('Seat allocation simulator')`, 'the allocation page');
    const verifiedEligiblePrograms = eligibilityResponse.body.filter((program) => (
      program.criteria_status === 'verified' && program.eligibility_status === 'eligible'
    ));
    if (verifiedEligiblePrograms.length) {
      await fill(devTools, '#allocation-program-choice', verifiedEligiblePrograms[0].program_id);
      await clickButton(devTools, 'Add preference');
      await clickButton(devTools, 'Run configured allocation simulation');
      await waitForPage(
        devTools,
        `document.body.innerText.includes('Allocation results') && document.body.innerText.includes('Not an official admission offer')`,
        'the non-official allocation simulation result',
      );
      const allocationRequestEntry = [...apiRequests.entries()].reverse().find(([, request]) => (
        request.path === '/api/allocation/simulate' && request.method === 'POST'
      ));
      assert.ok(allocationRequestEntry, 'The browser did not call POST /api/allocation/simulate.');
      await waitForRequest(allocationRequestEntry[1], 'The allocation simulation response');
      assert.equal(allocationRequestEntry[1].status, 200);
      const allocationResponse = JSON.parse(
        (await devTools.send('Network.getResponseBody', { requestId: allocationRequestEntry[0] })).body,
      );
      assert.ok(['allocated', 'unallocated'].includes(allocationResponse.waitlist_status));
      assert.ok(allocationResponse.run_id);
      const allocationText = await devTools.evaluate('document.body.innerText');
      check(
        allocationText.includes('Program ID') &&
          allocationText.includes('Why this result') &&
          allocationText.includes('not a confirmed seat'),
        'allocation UI shows backend results, explanation, and non-official disclaimer',
      );
    } else {
      const unavailableChoices = await devTools.evaluate(`({
        pickerDisabled: document.querySelector('#allocation-program-choice').disabled,
        runDisabled: [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Run configured allocation simulation').disabled,
        noVerifiedState: document.body.innerText.includes('No verified eligible program options are available.'),
      })`);
      assert.deepEqual(unavailableChoices, {
        pickerDisabled: true,
        runDisabled: true,
        noVerifiedState: true,
      });
      check(
        true,
        'allocation blocks simulation when no verified eligible programs are configured',
      );
    }
    await clickButton(devTools, 'Run demonstration');
    await waitForPage(devTools, `document.body.innerText.includes('Proposals, holds & rejections')`, 'the Gale-Shapley demonstration');
    const stableMatchingText = await devTools.evaluate('document.body.innerText');
    check(
      stableMatchingText.includes('Synthetic final matching') &&
        stableMatchingText.includes('Proposals, holds & rejections') &&
        stableMatchingText.includes('Sample program X'),
      'Gale-Shapley demonstration shows synthetic inputs, assignments, and proposal history',
    );

    await devTools.evaluate(`location.hash = 'interview';`);
    await waitForPage(devTools, `document.body.innerText.includes('Interactive interview practice')`, 'the interview practice page');
    await devTools.evaluate(`document.querySelector('.ai-chat-launcher').click()`);
    await waitForPage(devTools, `document.body.innerText.includes('Admission AI')`, 'the admission chatbot on the interview page');
    check(
      await devTools.evaluate(`Boolean(document.querySelector('.ai-chat-panel[role="dialog"]'))`),
      'the admission chatbot is available on the interview practice page',
    );
    await devTools.evaluate(`document.querySelector('[aria-label="Close chat"]').click()`);
    await waitForPage(devTools, `!document.querySelector('.ai-chat-panel')`, 'the closed admission chatbot');
    await fill(devTools, 'input[placeholder="e.g. Synthetic Data Science Program"]', 'Synthetic Data Science Program');
    await clickButton(devTools, 'Start a new practice session');
    await waitForPage(
      devTools,
      `document.body.innerText.includes('What synthetic project would you explore in the Data Science program?')`,
      'the interactive Ollama practice question',
    );
    for (let answerIndex = 0; answerIndex < 5; answerIndex += 1) {
      await fill(devTools, '#interview-answer', 'Synthetic practice answer');
      const answerCountBefore = [...apiRequests.values()].filter((request) => (
        request.path.endsWith('/answers') && request.method === 'POST'
      )).length;
      await clickButton(devTools, 'Submit answer');
      const answerDeadline = Date.now() + 10000;
      let interviewAnswerRequestEntry = null;
      while (Date.now() < answerDeadline) {
        interviewAnswerRequestEntry = [...apiRequests.entries()].reverse().find(([, request]) => (
          request.path.endsWith('/answers') && request.method === 'POST'
        ));
        const answerCount = [...apiRequests.values()].filter((request) => (
          request.path.endsWith('/answers') && request.method === 'POST'
        )).length;
        if (interviewAnswerRequestEntry && answerCount > answerCountBefore) break;
        await delay(50);
      }
      assert.ok(interviewAnswerRequestEntry, 'The browser did not submit an interview answer.');
      await waitForRequest(interviewAnswerRequestEntry[1], 'The interview answer response');
      assert.equal(interviewAnswerRequestEntry[1].status, 200, 'The interview answer endpoint did not complete.');
      if (answerIndex < 4) {
        await waitForPage(
          devTools,
          `(() => { const textarea = document.querySelector('#interview-answer'); return Boolean(textarea && !textarea.disabled); })()`,
          'the next interview answer input',
        );
      }
    }
    await waitForPage(
      devTools,
      `document.body.innerText.includes('Practice feedback')`,
      'the completed interview practice scorecard',
    );
    const interviewText = await devTools.evaluate(`document.body.innerText`);
    assert.ok(interviewText.includes('Practice feedback'), `Interview submission did not complete: ${interviewText.slice(-1500)}`);
    check(
      interviewText.includes('Progress: 5/5 answered') &&
        interviewText.includes('Generated by local Ollama') &&
        interviewText.includes('Evidence:'),
      'interactive interview generates a follow-up session and transparent practice feedback',
    );

    for (const width of [360, 768, 1280]) {
      await devTools.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width <= 640,
      });
      await delay(250);
      const expectedHeadings = {
        dashboard: 'Progress checklist',
        profile: 'Student profile',
        eligibility: 'College and course eligibility guidance',
        applications: 'Applications',
        explore: 'Explore & Apply',
        'ai-predictor': 'AI College Predictor',
        interview: 'Interactive interview practice',
        allocation: 'Application tracking',
        privacy: 'DPDP notice and consent',
      };
      for (const [page, heading] of Object.entries(expectedHeadings)) {
        await devTools.evaluate(`location.hash = ${JSON.stringify(page)};`);
        await waitForPage(devTools, `document.body.innerText.includes(${JSON.stringify(heading)})`, `${page} at ${width}px`);
        const hasHorizontalOverflow = await devTools.evaluate(
          'document.documentElement.scrollWidth > window.innerWidth + 1',
        );
        if (hasHorizontalOverflow) {
          const overflowDetails = await devTools.evaluate(`({ viewport: window.innerWidth, client: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, offenders: Array.from(document.querySelectorAll('body *'))
            .map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .filter(({ rect }) => rect.right > window.innerWidth + 1)
            .sort((a, b) => b.rect.right - a.rect.right)
            .slice(0, 8)
            .map(({ element, rect }) => ({ tag: element.tagName, className: element.className, left: rect.left, right: rect.right, width: rect.width })) })`);
          assert.fail(`${page} has horizontal overflow at ${width}px: ${JSON.stringify(overflowDetails)}`);
        }
      }
    }
    await devTools.send('Emulation.clearDeviceMetricsOverride');
    check(true, 'dashboard and all pages fit 360px, 768px, and 1280px viewports without horizontal overflow');

    await devTools.evaluate(`location.hash = 'privacy';`);
    await waitForPage(devTools, `document.body.innerText.includes('Download available data')`, 'the privacy controls page');
    await devTools.evaluate(`document.querySelector('.privacy-consent input').click();`);
    await waitForPage(devTools, `document.body.innerText.includes('Acknowledgment active for this page session only')`, 'the privacy acknowledgment');
    await clickButton(devTools, 'Download JSON');
    const exportPath = join(downloadDir, 'uniapply-account-data.json');
    const exportDeadline = Date.now() + 10000;
    while (!existsSync(exportPath) && Date.now() < exportDeadline) await delay(50);
    assert.ok(existsSync(exportPath), 'The account data export was not downloaded.');
    const accountExport = JSON.parse(readFileSync(exportPath, 'utf8'));
    assert.ok(Array.isArray(accountExport.applications), 'The account export is missing applications.');
    assert.ok(Array.isArray(accountExport.allocation_history), 'The account export is missing allocation history.');
    assert.equal(
      Object.prototype.hasOwnProperty.call(accountExport, 'document_contents'),
      false,
      'The account export must not include original uploaded file contents.',
    );
    check(true, 'privacy page exports account applications and allocation history without uploaded file contents');
    await devTools.evaluate(`location.hash = 'profile';`);
    await waitForPage(devTools, `document.body.innerText.includes('AI profile intake')`, 'the profile intake fallback');
    const chatRequestsBeforeOutage = ollama.chatRequests;
    ollama.setAvailable(false);
    await fill(devTools, '#profile-intake-description', description);
    await clickButton(devTools, 'Extract profile for review');
    await waitForPage(
      devTools,
      `document.body.innerText.includes('Local Ollama is unavailable. Start it with')`,
      'the explicit Ollama-unavailable error',
    );
    const unavailableText = await devTools.evaluate(`document.body.innerText`);
    check(
      !unavailableText.includes('Model-generated by') &&
        !unavailableText.includes('Apply these reviewed fields to my profile') &&
        unavailableText.includes('Step 1 of 3'),
      'Ollama outage is shown honestly without fabricated fallback output',
    );
    check(
      ollama.chatRequests === chatRequestsBeforeOutage,
      'unavailable Ollama is detected before any model-generation request',
    );

    const unauthenticated = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/profile').then((response) => response.status)`,
    );
    const secondEmail = `student-${randomUUID().replaceAll('-', '').slice(0, 12)}@example.com`;
    const secondStudent = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ full_name: 'Synthetic Second Student', email: ${JSON.stringify(secondEmail)}, password: ${JSON.stringify(password)} }) }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
    );
    assert.equal(secondStudent.status, 200);
    const secondProfileBefore = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/profile', { headers: { Authorization: 'Bearer ' + ${JSON.stringify(secondStudent.body.token)} } }).then((response) => response.json())`,
    );
    const directOtherProfile = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/profile/' + ${JSON.stringify(secondStudent.body.user.id)}, { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('uniapply-token') } }).then((response) => response.status)`,
    );
    const allocationRunForIsolation = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/allocation/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('uniapply-token') }, body: JSON.stringify({ student_id: ${JSON.stringify(savedProfile.student_id)}, preferences: [${JSON.stringify(eligibilityResponse.body[0].program_id)}] }) }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
    );
    assert.equal(allocationRunForIsolation.status, 200);
    const otherAllocation = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/allocation/runs/' + ${JSON.stringify(allocationRunForIsolation.body.run_id)}, { headers: { Authorization: 'Bearer ' + ${JSON.stringify(secondStudent.body.token)} } }).then((response) => response.status)`,
    );
    const otherProfileAfter = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/profile', { headers: { Authorization: 'Bearer ' + ${JSON.stringify(secondStudent.body.token)} } }).then((response) => response.json())`,
    );
    check(
      unauthenticated === 401 &&
        directOtherProfile === 404 &&
        otherAllocation === 404 &&
        secondProfileBefore.student_id === secondStudent.body.user.id &&
        JSON.stringify(secondProfileBefore) === JSON.stringify(otherProfileAfter),
      'unauthenticated profile access is rejected and one student cannot read another profile or allocation',
    );

    const universityLogin = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@uniapply.ai', password: 'AdminPass123!' }) }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
    );
    assert.equal(universityLogin.status, 200);
    const universityToken = universityLogin.body.token;
    const program = {
      criteria_id: 'synthetic-e2e-admissions-criteria',
      institution_id: 'synthetic-institute',
      program_id: 'synthetic-e2e-admissions-program',
      institution: 'Synthetic E2E Institute',
      program: 'Synthetic E2E Program',
      location: 'Synthetic City',
      tuition_budget: null,
      seat_capacity: null,
      priority_rules: [],
      minimum_percentage: 65,
      minimum_marks: null,
      marks_out_of: null,
      required_subjects: [],
      required_qualifications: [],
      examination_type: null,
      examination_cutoff: null,
      examination_comparison: 'minimum',
      admission_year: null,
      required_category: null,
      required_domicile: null,
      required_documents: [],
      source: 'Synthetic browser-test criteria; not real admissions data',
      effective_year: 2027,
      criteria_status: 'verified',
      application_mode: 'direct',
      application_cycle: 2027,
      application_deadline: null,
      application_fee: null,
      official_application_url: null,
    };
    const linkedCollegeName = exploreDirectoryResponse.body.colleges[0].name;
    const collegePortalProgram = {
      ...program,
      criteria_id: 'synthetic-e2e-college-link-criteria',
      program_id: 'synthetic-e2e-college-link-program',
      institution: linkedCollegeName,
      program: 'Synthetic linked course',
      minimum_percentage: 100,
      application_mode: 'external',
      application_cycle: 2027,
      official_application_url: 'https://admissions.example.edu/apply',
      official_website: 'https://www.example.edu',
    };
    const criteriaResponse = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/university/program-criteria', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ${JSON.stringify(universityToken)} }, body: JSON.stringify({ programs: [${JSON.stringify(program)}, ${JSON.stringify(collegePortalProgram)}] }) }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
    );
    assert.equal(criteriaResponse.status, 200);
    await devTools.evaluate(`location.hash = 'explore';`);
    await waitForPage(
      devTools,
      `document.body.innerText.includes(${JSON.stringify(linkedCollegeName)}) && document.body.innerText.includes('Apply Now')`,
      'the verified official application portal link',
    );
    const configuredPortalLink = await devTools.evaluate(`(() => {
      const card = [...document.querySelectorAll('.explore-college-card')].find((item) => item.innerText.includes(${JSON.stringify(linkedCollegeName)}));
      const link = card?.querySelector('a.explore-apply-button');
      return link ? { href: link.href, target: link.target, rel: link.rel, label: link.innerText.replace(/\\s+/g, ' ').trim() } : null;
    })()`);
    assert.deepEqual(configuredPortalLink, {
      href: 'https://admissions.example.edu/apply',
      target: '_blank',
      rel: 'noopener noreferrer',
      label: 'Apply Now ↗',
    });
    check(true, 'verified institution application URLs open in a new protected tab');
    const studentToken = await devTools.evaluate(`sessionStorage.getItem('uniapply-token')`);
    const eligibleProfile = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/profile', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ${JSON.stringify(studentToken)} }, body: JSON.stringify({ academic_score: 90 }) }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
    );
    assert.equal(eligibleProfile.status, 200);
    await devTools.evaluate(`location.hash = 'eligibility';`);
    await waitForPage(devTools, `document.body.innerText.includes('Refresh eligibility data')`, 'the refreshed eligibility page');
    await clickButton(devTools, 'Refresh eligibility data');
    await waitForPage(
      devTools,
      `document.body.innerText.includes('Synthetic E2E Institute')`,
      'the verified synthetic eligibility result',
    );
    await devTools.evaluate(`location.hash = 'allocation';`);
    await waitForPage(
      devTools,
      `Array.from(document.querySelector('#allocation-program-choice').options).some((option) => option.value === ${JSON.stringify(program.program_id)})`,
      'the verified program preference picker',
    );
    await fill(devTools, '#allocation-program-choice', program.program_id);
    await clickButton(devTools, 'Add preference');
    await clickButton(devTools, 'Run configured allocation simulation');
    await waitForPage(
      devTools,
      `document.body.innerText.includes('Why this result') && document.body.innerText.includes('Program ID')`,
      'the verified configured allocation result',
    );
    const verifiedAllocationRequest = [...apiRequests.entries()].reverse().find(([, request]) => (
      request.path === '/api/allocation/simulate' && request.method === 'POST'
    ));
    assert.ok(verifiedAllocationRequest, 'The verified program did not trigger the allocation API.');
    await waitForRequest(verifiedAllocationRequest[1], 'The verified allocation response');
    assert.equal(verifiedAllocationRequest[1].status, 200);
    check(true, 'verified eligible programs can be selected and evaluated by the configured allocation API');
    const applicationDraft = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/applications', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ${JSON.stringify(studentToken)} }, body: JSON.stringify({ program_id: ${JSON.stringify(program.program_id)} }) }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
    );
    assert.equal(applicationDraft.status, 201);
    const applicationSubmission = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/applications/' + ${JSON.stringify(applicationDraft.body.application_id)} + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ${JSON.stringify(studentToken)} }, body: JSON.stringify({ consent: true }) }).then(async (response) => ({ status: response.status, body: await response.json() }))`,
    );
    assert.equal(applicationSubmission.status, 200);
    assert.equal(applicationSubmission.body.status, 'submitted');
    await devTools.evaluate(`location.hash = 'privacy';`);
    await waitForPage(devTools, `document.body.innerText.includes('Download available data')`, 'the account export with an application');
    rmSync(exportPath, { force: true });
    await clickButton(devTools, 'Download JSON');
    const applicationExportDeadline = Date.now() + 10000;
    while (!existsSync(exportPath) && Date.now() < applicationExportDeadline) await delay(50);
    assert.ok(existsSync(exportPath), 'The account export with an application was not downloaded.');
    const submittedAccountExport = JSON.parse(readFileSync(exportPath, 'utf8'));
    assert.ok(
      submittedAccountExport.applications.some((item) => item.application_id === applicationSubmission.body.application_id),
      'The account export does not include the submitted application.',
    );
    check(true, 'account export includes a submitted application record');
    await devTools.evaluate(`sessionStorage.setItem('uniapply-token', ${JSON.stringify(universityToken)}); location.reload();`);
    await waitForPage(devTools, `document.body.innerText.includes('University portal')`, 'the university review portal');
    await waitForPage(
      devTools,
      `document.body.innerText.includes(${JSON.stringify(applicationSubmission.body.reference_id)})`,
      'the submitted application in the institution-scoped review list',
    );
    check(
      applicationSubmission.body.reference_id.startsWith('UA-2027-')
        && (await devTools.evaluate('document.body.innerText')).includes('Synthetic E2E Program'),
      'verified synthetic criteria support direct student submission and institution-scoped review',
    );
    await devTools.evaluate(`sessionStorage.setItem('uniapply-token', ${JSON.stringify(studentToken)}); location.hash = 'privacy'; location.reload();`);
    await waitForPage(devTools, `document.body.innerText.includes('Manage your account data')`, 'the student account data controls');
    await devTools.evaluate(`document.querySelector('.account-button').click()`);
    await clickButton(devTools, 'Delete account');
    await waitForPage(devTools, `Boolean(document.querySelector('.delete-confirm-dialog input'))`, 'the account deletion confirmation');
    await fill(devTools, '.delete-confirm-dialog input', 'DELETE');
    await clickButton(devTools, 'Delete account permanently');
    await waitForPage(devTools, `document.body.innerText.includes('Welcome back')`, 'the signed-out account deletion result');
    const deletedAccountProfileStatus = await browserFetch(
      devTools,
      `fetch(${apiOrigin} + '/profile', { headers: { Authorization: 'Bearer ' + ${JSON.stringify(studentToken)} } }).then((response) => response.status)`,
    );
    check(
      deletedAccountProfileStatus === 401,
      'account deletion confirmation removes the test account and signs the student out',
    );
  } catch (error) {
    console.error(`Browser journey failure: ${error instanceof Error ? error.stack : String(error)}`);
    const logs = children
      .filter((child) => child.outputTail)
      .map((child) => `--- ${child.label} ---\n${child.outputTail}`)
      .join('\n');
    if (logs) console.error(`Service logs:\n${logs}`);
    throw error;
  } finally {
    if (devTools) {
      await devTools.send('Browser.close').catch(() => undefined);
      devTools.close();
    }
    await stopProcess(browser);
    for (const child of children.slice().reverse()) await stopProcess(child);
    if (ollama.server.listening) {
      await new Promise((resolveClose) => ollama.server.close(resolveClose));
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        rmSync(testTempDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error?.code !== 'EBUSY' || attempt === 5) throw error;
        await delay(250);
      }
    }
  }
}

main()
  .then(() => {
    console.log(`RESULT: ${passed} passed, 0 failed, 0 skipped`);
  })
  .catch((error) => {
    console.error(`RESULT: ${passed} passed, 1 failed, 0 skipped`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
