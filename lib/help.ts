/** Accept international phone numbers with common, human-friendly formatting. */
export function validHelpPhone(phone: string): boolean {
  const trimmed = phone.trim()
  const digits = trimmed.replace(/\D/g, '')
  return /^\+?[\d\s().-]+$/.test(trimmed) && digits.length >= 7 && digits.length <= 15
}

export function validHelpMessage(message: string): boolean {
  return message.trim().length >= 10 && message.length <= 3000
}
