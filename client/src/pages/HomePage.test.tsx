import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { ConfirmProvider } from '../components/ConfirmDialog';
import HomePage from './HomePage';

it.each(['/collections', '/collections/', '/Collections'])('opens the Collections library tab for router-matched URL %s', url => {
  const html = renderToStaticMarkup(<StaticRouter location={url}><ConfirmProvider><HomePage /></ConfirmProvider></StaticRouter>);
  expect(html).toMatch(/id="library-collections-tab" aria-selected="true"/);
  expect(html).toContain('Collection name');
  expect(html).not.toContain('All files');
});

it('preserves folder browsing controls alongside the Collections tab', () => {
  const html = renderToStaticMarkup(<StaticRouter location="/"><ConfirmProvider><HomePage /></ConfirmProvider></StaticRouter>);
  expect(html).toMatch(/id="library-folders-tab" aria-selected="true"/);
  expect(html).toContain('All files');
  expect(html).not.toContain('Collection name');
});
