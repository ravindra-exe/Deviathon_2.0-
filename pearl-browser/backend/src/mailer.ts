import nodemailer from 'nodemailer'

export interface OtpMessage {
  email: string
  assessmentId: string
  code: string
  expiresAt: Date
}

export interface OtpDelivery {
  send(message: OtpMessage): Promise<void>
}

export interface SmtpConfig {
  host: string
  port: number
  user: string
  pass: string
  from: string
  secure: boolean
}

export class SmtpOtpDelivery implements OtpDelivery {
  private readonly transporter
  constructor(config: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000
    })
    this.from = config.from
  }
  private readonly from: string
  async send(message: OtpMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.email,
      subject: 'Pearl Browser verification code',
      text: `Your Pearl Browser verification code is ${message.code}. It expires at ${message.expiresAt.toISOString()}. Assessment: ${message.assessmentId}. If you did not request this code, you can ignore this email.`
    })
  }
}
