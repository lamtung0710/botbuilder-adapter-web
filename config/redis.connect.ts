const Redis = require("ioredis");
import dotenv from 'dotenv';
dotenv.config();
const {
    REDIS_PORT,
    REDIS_HOST,
    REDIS_AUTH,
    REDIS_DBNUMBER,
    REDIS_IPV
} = process.env;

const RedisClient = new Redis({
    port: REDIS_PORT,
    host: REDIS_HOST,
    family: REDIS_IPV,
    password: REDIS_AUTH,
    db: REDIS_DBNUMBER,
});


export { RedisClient };
