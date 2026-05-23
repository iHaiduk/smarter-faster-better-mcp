export class MissingConfigError extends Error {
  override readonly name = 'MissingConfigError'
}

export class InvalidParserModeError extends Error {
  override readonly name = 'InvalidParserModeError'
}
