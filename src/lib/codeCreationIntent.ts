export const CODE_CREATION_PATTERN = /(?:созда|сдела|собер|напиш|build|create|make|yarat).{0,80}(?:сайт|лендинг|компонент|интерфейс|приложен|скрипт|website|landing|component|interface|app|script)|(?:react|typescript|html|css|javascript).{0,50}(?:созда|build|create|yarat)/i

export function isCodeCreationIntent(value: string): boolean {
  return CODE_CREATION_PATTERN.test(value)
}
