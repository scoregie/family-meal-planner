// Prints a password hash for a LOGIN_<USERNAME>= line in .env
// Usage: docker compose run --rm api node /app/hash-password.js 'the password'
process.env.SESSION_SECRET=process.env.SESSION_SECRET||'unused';
const pw=process.argv[2];
if(!pw){console.error("Usage: node hash-password.js 'the password'");process.exit(1);}
console.log(require('./auth').hash(pw));
