export class Logger {
  constructor(private serviceName: string) {}

  private getFormattedTime(): string {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const year = now.getFullYear();
    const month = pad(now.getMonth() + 1);
    const day = pad(now.getDate());
    const hours = pad(now.getHours());
    const minutes = pad(now.getMinutes());
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  private formatPrefix(level: string): string {
    return `[${this.getFormattedTime()}] [${this.serviceName}] [${level}]`;
  }

  info(message?: any, ...optionalParams: any[]) {
    console.log(this.formatPrefix("INFO"), message ?? "", ...optionalParams);
  }

  warn(message?: any, ...optionalParams: any[]) {
    console.warn(this.formatPrefix("WARN"), message ?? "", ...optionalParams);
  }

  error(message?: any, ...optionalParams: any[]) {
    console.error(this.formatPrefix("ERROR"), message ?? "", ...optionalParams);
  }
}

export const createLogger = (serviceName: string) => new Logger(serviceName);
