import { expect, it } from 'vitest';

it('web test setup runs in a DOM environment', () => {
  document.body.innerHTML = '<p id="x">ok</p>';
  expect(document.getElementById('x')?.textContent).toBe('ok');
});
