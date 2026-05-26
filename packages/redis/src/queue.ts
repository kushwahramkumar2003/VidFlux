import { getRedisConnection } from "./redis";

const redis = getRedisConnection();

export const push = async (queue: string, data: object): Promise<number> => {
  return redis.lPush(queue, JSON.stringify(data));
};

export const pop = async <T>(queue: string): Promise<T | null> => {
  const value = await redis.rPop(queue);
  return value ? (JSON.parse(value) as T) : null;
};

// blocking pop — waits until an item is available
export const bPop = async <T>(
  queue: string,
  timeout: number = 5
): Promise<T | null> => {
  const result = await redis.brPop(queue, timeout);
  return result ? (JSON.parse(result.element) as T) : null;
};

// bulk
export const bulkPush = async (
  queue: string,
  data: object[]
): Promise<number> => {
  const multi = redis.multi();
  data.forEach((item) => multi.lPush(queue, JSON.stringify(item)));
  await multi.exec();
  return data.length;
};

export const bulkPop = async <T>(
  queue: string,
  count: number
): Promise<T[]> => {
  const multi = redis.multi();
  for (let i = 0; i < count; i++) multi.rPop(queue);
  const results = await multi.exec();
  return (results as (string | null)[])
    .filter(Boolean)
    .map((item) => JSON.parse(item as string) as T);
};

// Peak inspect

export const peek = async <T>(queue: string): Promise<T | null> => {
  const value = await redis.lIndex(queue, -1); // tail (next to pop)
  return value ? (JSON.parse(value) as T) : null;
};

export const queueLength = async (queue: string): Promise<number> => {
  return redis.lLen(queue);
};

export const peekAll = async <T>(queue: string): Promise<T[]> => {
  const values = await redis.lRange(queue, 0, -1);
  return values.map((v) => JSON.parse(v) as T);
};
