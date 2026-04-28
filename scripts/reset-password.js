#!/usr/bin/env node
'use strict';

const bcrypt = require('bcrypt');
const readline = require('readline');
const { loadUsers, saveUsers, findUser } = require('../auth');

const SALT_ROUNDS = 10;

function hashPassword(plain) {
  return bcrypt.hashSync(plain, SALT_ROUNDS);
}

function updateUserPassword(username, hashedPassword) {
  const data = loadUsers();
  const user = data.users.find((entry) => entry.username === username);
  if (!user) {
    console.error(`Error: User not found: ${username}`);
    process.exit(1);
  }
  user.password_hash = hashedPassword;
  saveUsers(data);
}

function printConfirmation(username) {
  console.log('');
  console.log('Password has been updated and hashed with bcrypt.');
  console.log(`Updated user: ${username}`);
  console.log('');
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const usernameArg = process.argv[2];
  const passwordArg = process.argv[3];

  const username = (usernameArg || await prompt('Username to reset: ')).trim();
  if (!username) {
    console.error('Error: Username cannot be empty.');
    process.exit(1);
  }
  if (!findUser(username)) {
    console.error(`Error: User not found: ${username}`);
    process.exit(1);
  }

  const newPassword = passwordArg || await prompt('Enter new password: ');
  if (!newPassword || newPassword.trim() === '') {
    console.error('Error: Password cannot be empty.');
    process.exit(1);
  }
  if (newPassword.trim().length < 8) {
    console.error('Error: Password must be at least 8 characters.');
    process.exit(1);
  }

  console.log('Hashing password with bcrypt (10 rounds)...');
  const hashed = hashPassword(newPassword.trim());
  updateUserPassword(username, hashed);
  printConfirmation(username);
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
