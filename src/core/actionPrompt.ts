import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isNumberKey,
  isUpKey,
  useKeypress,
  useState,
} from '@inquirer/core';
import { theme } from './theme.js';

interface NumberedChoice {
  value: string;
  description: string;
}

interface NumberedActionPromptConfig {
  message: string;
  choices: readonly NumberedChoice[];
}

export const numberedActionPrompt = createPrompt<string, NumberedActionPromptConfig>((config, done) => {
  const [active, setActive] = useState(0);
  const [completed, setCompleted] = useState(false);
  const selected = config.choices[active];

  useKeypress((key, readline) => {
    if (isNumberKey(key)) {
      const selectedIndex = Number(key.name) - 1;
      const choice = config.choices[selectedIndex];
      if (choice) {
        setActive(selectedIndex);
        setCompleted(true);
        done(choice.value);
      }
      return;
    }

    if (isEnterKey(key)) {
      setCompleted(true);
      done(selected.value);
      return;
    }

    if (isUpKey(key)) {
      readline.clearLine(0);
      setActive((active - 1 + config.choices.length) % config.choices.length);
      return;
    }

    if (isDownKey(key)) {
      readline.clearLine(0);
      setActive((active + 1) % config.choices.length);
    }
  });

  if (completed) {
    return `${theme.success('✔')} ${theme.heading(config.message)} ${theme.text(selected.value)}`;
  }

  const choices = config.choices.map((choice, index) => {
    const line = `${index + 1}. ${choice.value}`;
    return index === active ? theme.info(`❯ ${line}`) : `  ${line}`;
  });

  return [
    `${theme.info('?')} ${theme.heading(config.message)}`,
    ...choices,
    '',
    theme.muted(selected.description),
    theme.muted('Use ↑/↓ and Enter, or press 1-4.'),
  ].join('\n');
});
