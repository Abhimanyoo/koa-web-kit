'use strict';
const fs = require('fs');
const path = require('path');
const Router = require('koa-router');
const koaBody = require('koa-body');
const request = require('request');
const fromString = require('from2-string');
const config = require('../config/env');
const utils = require('../config/utils');
const logger = require('../services/logger');

const isSSREnabled = config.isSSREnabled();
const isHMREnabled = config.isHMREnabled();
const appPrefix = utils.normalizeTailSlash(config.getAppPrefix());
const ENTRY_NAME = utils.ENTRY_NAME;
const publicPath = utils.getPublicPath();
const DEV_MODE = config.isDevMode();

let indexHtml = '';
let s;
let manifest;
let groupedManifest;
let styleLinks = '';
let manifestInlineScript = '';

if (isSSREnabled) {
  const SSR = require('../build/node/ssr');
  groupedManifest = SSR.groupedManifest;
  manifest = groupedManifest.manifest;
  // console.log('manifest: ', manifest);
  styleLinks = groupedManifest.styles
    ? groupedManifest.styles
        .map(style => {
          return `<link href="${publicPath}${style}" rel="stylesheet">`;
        })
        .join('\n')
    : '';
  manifestInlineScript = `<script type="text/javascript" src="${publicPath +
    manifest[ENTRY_NAME.RUNTIME_JS]}"></script>`;
  if (!DEV_MODE) {
    // console.log(manifest);
    // console.log(manifest[ENTRY_NAME.RUNTIME_JS]);
    const temp = fs.readFileSync(
      path.join(__dirname, `../build/app/${manifest[ENTRY_NAME.RUNTIME_JS]}`),
      { encoding: 'utf-8' }
    );
    manifestInlineScript = `<script type="text/javascript">${temp}</script>`;
  }

  s = new SSR();
} else if (!isHMREnabled) {
  try {
    indexHtml = fs.readFileSync(
      path.join(__dirname, `../build/app/index.html`),
      {
        encoding: 'utf-8',
      }
    );
  } catch (e) {
    console.error('failed to read build/app/index.html...');
    // console.error(e);
  }
}

const router = new Router({
  prefix: appPrefix,
});

router.use(async function(ctx, next) {
  // console.log(`start of index router: ${ctx.path}`);
  ctx.set('Cache-Control', 'no-cache');
  ctx.state = {
    initialData: {},
  };
  await next();
  // console.log(`end of index router: ${ctx.path}`);
});

router.post('/user', koaBody({ multipart: true }), async function(ctx) {
  const body = ctx.request.body;
  // console.log(body);
  ctx.body = { result: body };
});

router.get('/github', async function(ctx) {
  if (!isSSREnabled) {
    ctx.body = genHtml();
    return;
  }
  //use isomorphic-fetch to share the fetch logic
  const ret = await new Promise((resole, reject) => {
    request(
      'https://api.github.com/repos/jasonboy/wechat-jssdk/branches',
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1',
        },
        json: true,
      },
      (error, response, body) => {
        if (error) {
          console.log('error:', error); // Print the error if one occurred
          reject(error);
        }
        console.log('statusCode:', response && response.statusCode); // Print the response status code if a response was received
        // console.log('body:', body); // Print the HTML for the Google homepage.
        resole(body);
      }
    );
  });

  const data = { github: ret };

  renderSSR(ctx, data, true);
});

router.get('*', async function(ctx) {
  if (!isSSREnabled) {
    ctx.body = genHtml();
    return;
  }

  renderSSR(ctx, undefined, false);
});

/**
 * Server side rendering components
 * @param {object} ctx koa ctx
 * @param {object=} data initial data
 * @param {Boolean=} streaming whether to user streaming api or not
 */
function renderSSR(ctx, data = {}, streaming) {
  if (!streaming) {
    logger.info('-----> Use React SSR Sync API!');
    const rendered = s.render(ctx.url, data);
    rendered.initialData = data;
    ctx.body = genHtml(rendered.html, rendered);
    return;
  }
  logger.info('-----> Use React SSR Streaming API!');
  //use streaming api
  const rendered = s.renderWithStream(ctx.url, data);
  rendered.initialData = data;
  ctx.set({
    'Content-Type': 'text/html',
  });
  ctx.status = 200;
  ctx.respond = false;
  genHtmlStream(rendered.html, rendered, ctx.res);
}

function genHtml(html, extra = {}) {
  if (indexHtml) {
    return indexHtml;
  }

  const loadableComponents = extra.scripts || [];
  const renderedComponentsScripts = loadableComponents.join('');

  let ret = `
    <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, user-scalable=no">
        <title>${extra.title || 'React App'}</title>
        ${styleLinks}
      </head>
      <body>
        <div id="app">${html}</div>
        <script type="text/javascript">window.__INITIAL_DATA__ = ${JSON.stringify(
          extra.initialData || {}
        )}</script>
        ${manifestInlineScript}
        ${renderedComponentsScripts}
        
        <script type="text/javascript" src="${publicPath +
          manifest[ENTRY_NAME.APP_JS]}"></script>
      </body>
    </html>
  `;

  return ret;
}

function genHtmlStream(nodeStreamFromReact, extra = {}, res) {
  // const loadableComponents = extra.scripts || [];
  // const renderedComponentsScripts = loadableComponents.join('');
  const before = `
    <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, user-scalable=no">
        <title>${extra.title || 'React App'}</title>
        ${styleLinks}
      </head>
      <body><div id="app">`;

  res.write(before);

  nodeStreamFromReact.pipe(
    res,
    { end: false }
  );

  nodeStreamFromReact.on('end', () => {
    logger.info('nodeStreamFromReact end');
    let renderedComponentsScripts = [];
    //get rendered components for react-loadable after reactNodeStream done
    if (extra.modules) {
      // console.log('extra.modules:', extra.modules);
      renderedComponentsScripts = s.getRenderedBundleScripts(extra.modules);
    }
    const after = `</div>
    <script type="text/javascript">window.__INITIAL_DATA__ = ${JSON.stringify(
      extra.initialData || {}
    )}</script>
        ${manifestInlineScript}
        ${renderedComponentsScripts}
        <script type="text/javascript" src="${publicPath +
          manifest[ENTRY_NAME.APP_JS]}"></script>
      </body>
    </html>
  `;
    //in case the initial data and the runtime code is big, also use stream here
    const afterStream = fromString(after);
    afterStream.pipe(
      res,
      { end: false }
    );
    afterStream.on('end', () => {
      logger.info('afterStream done');
      res.end();
    });

    // res.write(after);
    // res.end();
  });
}

module.exports = router;
