// One name implemented by several classes is polymorphism: each must supply
// its own, and that is the design rather than a repetition.
abstract class Processor {
  abstract extract(event: Record<string, string>): string;
}

export class AlbProcessor extends Processor {
  extract(event: Record<string, string>): string {
    const query = event.queryString ?? '';
    const decoded = decodeURIComponent(query);
    return 'alb:' + decoded.trim();
  }
}

export class GatewayProcessor extends Processor {
  extract(event: Record<string, string>): string {
    const query = event.rawQuery ?? '';
    const decoded = decodeURIComponent(query);
    return 'gateway:' + decoded.trim();
  }
}
