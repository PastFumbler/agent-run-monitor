// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChoiceGroup, FolderList, SwitchRow, ThemePicker } from './controls';

afterEach(cleanup);

describe('SwitchRow', () => {
  it('is a labelled, described switch with aria-checked and a visible On/Off word', () => {
    const onChange = vi.fn();
    render(<SwitchRow label="Mask likely secrets" description="Hides keys." checked onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Mask likely secrets' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(sw.getAttribute('aria-describedby')!)?.textContent).toBe('Hides keys.');
    expect(sw.textContent).toContain('On');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe('ChoiceGroup', () => {
  it('is a fieldset of native radios named by its legend', () => {
    const onChange = vi.fn();
    render(
      <ChoiceGroup
        legend="Low GPU usage mode"
        value="auto"
        choices={[
          { value: 'auto', label: 'Auto - turns on when running on battery', name: 'Auto' },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
        onChange={onChange}
      />,
    );
    const group = screen.getByRole('group', { name: 'Low GPU usage mode' });
    const radios = group.querySelectorAll('input[type=radio]');
    expect(radios).toHaveLength(3);
    expect((screen.getByRole('radio', { name: 'Auto' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    expect(onChange).toHaveBeenCalledWith('on');
  });
});

describe('ThemePicker', () => {
  it('offers six themes labelled light or dark, each preview scoped to its own tokens', () => {
    const onChange = vi.fn();
    render(<ThemePicker value="paper" onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(6);
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Paper, light',
      'Sage, light',
      'Dawn, light',
      'Dusk, dark',
      'Moss, dark',
      'Harbor, dark',
    ]);
    const previews = document.querySelectorAll<HTMLElement>('.theme-card__preview');
    expect(previews[3].style.getPropertyValue('--surface')).toMatch(/^#/);
    expect(previews[0].style.getPropertyValue('--surface')).not.toBe(previews[3].style.getPropertyValue('--surface'));
    fireEvent.click(screen.getByRole('radio', { name: 'Harbor, dark' }));
    expect(onChange).toHaveBeenCalledWith('harbor');
  });
});

describe('FolderList', () => {
  it('lists folders with labelled Remove buttons and an Add button', () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    render(<FolderList folders={['/a/b']} listLabel="Extra folders" onAdd={onAdd} onRemove={onRemove} addName="Add folder for Codex" />);
    expect(screen.getByRole('list', { name: 'Extra folders' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove /a/b' }));
    expect(onRemove).toHaveBeenCalledWith('/a/b');
    fireEvent.click(screen.getByRole('button', { name: 'Add folder for Codex' }));
    expect(onAdd).toHaveBeenCalled();
  });
});
