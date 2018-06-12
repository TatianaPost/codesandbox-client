import { camelizeKeys } from 'humps';
import { isStandalone, listen, dispatch } from 'codesandbox-api';

import _debug from 'app/utils/debug';

import registerServiceWorker from 'common/registerServiceWorker';
import requirePolyfills from 'common/load-dynamic-polyfills';
import { getModulePath } from 'common/sandbox/modules';
import { generateFileFromSandbox } from 'common/templates/configuration/package-json';
import setupConsole from 'sandbox-hooks/console';
import setupHistoryListeners from 'sandbox-hooks/url-listeners';
import { Encode } from 'console-feed/lib/Transform';

import compile, { getCurrentManager } from './compile';

const host = process.env.CODESANDBOX_HOST;
const debug = _debug('cs:sandbox');

export const SCRIPT_VERSION =
  document.currentScript && document.currentScript.src.replace(host + '/', '');

debug('Booting sandbox');

function getId() {
  if (process.env.LOCAL_SERVER) {
    return document.location.hash.replace('#', '');
  }

  if (process.env.STAGING) {
    const segments = host.split('//')[1].split('.');
    const first = segments.shift();
    const re = RegExp(`${first}-(.*)\\.${segments.join('\\.')}`);
    return document.location.host.match(re)[1];
  }

  const hostRegex = host.replace(/https?:\/\//, '').replace(/\./g, '\\.');
  const sandboxRegex = new RegExp(`(.*)\\.${hostRegex}`);
  return document.location.host.match(sandboxRegex)[1];
}

requirePolyfills().then(() => {
  registerServiceWorker('/sandbox-service-worker.js', {});

  function sendReady() {
    dispatch({ type: 'initialized' });
  }

  async function handleMessage(data, source) {
    if (source) {
      if (data.type === 'compile') {
        if (data.version === 3) {
          compile(data);
        } else {
          const compileOld = await import('./compile-old').then(x => x.default);
          compileOld(data);
        }
      } else if (data.type === 'urlback') {
        history.back();
      } else if (data.type === 'urlforward') {
        history.forward();
      } else if (data.type === 'refresh') {
        document.location.reload();
      } else if (data.type === 'evaluate') {
        let result = null;
        let error = false;
        try {
          // Attempt to wrap command in parentheses, fixing issues
          // where directly returning objects results in unexpected
          // behaviour.
          if (data.command && data.command.charAt(0) === '{') {
            try {
              const wrapped = `(${data.command})`;
              // `new Function` is used to validate Javascript syntax
              const validate = new Function(wrapped);
              data.command = wrapped;
            } catch (e) {
              // We shouldn't wrap the expression
            }
          }

          result = (0, eval)(data.command); // eslint-disable-line no-eval
        } catch (e) {
          result = e;
          error = true;
        }

        try {
          dispatch({
            type: 'eval-result',
            error,
            result: Encode(result),
          });
        } catch (e) {
          console.error(e);
        }
      } else if (data.type === 'get-transpiler-context') {
        const manager = getCurrentManager();

        if (manager) {
          const context = await manager.getTranspilerContext();
          dispatch({
            type: 'transpiler-context',
            data: context,
          });
        } else {
          dispatch({
            type: 'transpiler-context',
            data: {},
          });
        }
      }
    }
  }

  if (!isStandalone) {
    listen(handleMessage);

    sendReady();

    setupHistoryListeners();
    setupConsole();
  }

  if (process.env.NODE_ENV === 'test' || isStandalone) {
    // We need to fetch the sandbox ourselves...
    const id = getId();
    window
      .fetch(host + `/api/v1/sandboxes/${id}`, {
        credentials: 'include',
      })
      .then(res => res.json())
      .then(res => {
        const camelized = camelizeKeys(res);
        camelized.data.npmDependencies = res.data.npm_dependencies;

        return camelized;
      })
      .then(x => {
        const moduleObject = {};

        // We convert the modules to a format the manager understands
        x.data.modules.forEach(m => {
          const path = getModulePath(x.data.modules, x.data.directories, m.id);
          moduleObject[path] = {
            path,
            code: m.code,
          };
        });

        if (!moduleObject['/package.json']) {
          moduleObject['/package.json'] = {
            code: generateFileFromSandbox(x.data),
            path: '/package.json',
          };
        }

        const data = {
          sandboxId: id,
          modules: moduleObject,
          entry: '/' + x.data.entry,
          externalResources: x.data.externalResources,
          dependencies: x.data.npmDependencies,
          hasActions: false,
          template: x.data.template,
          version: 3,
        };

        compile(data);
      });
  }
});
