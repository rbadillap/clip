#!/usr/bin/env node

const { OpenAI } = require("openai");
const readline = require('readline');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// Remove the padding constants
const CONSOLE_WIDTH = 80; // Reasonable terminal width for wrapping
const DIVIDER = "─".repeat(CONSOLE_WIDTH);

// Create a unified data directory structure
const CLIP_DIR = path.join(os.homedir(), '.clipai');
const CONVERSATIONS_DIR = path.join(CLIP_DIR, 'conversations');
const RESPONSES_DIR = path.join(CLIP_DIR, 'responses');
const STATE_FILE = path.join(CLIP_DIR, 'state.json');

// Legacy files for backward compatibility
const historyFile = path.join(os.homedir(), '.clip_history');
let commandHistory = [];

// Track conversation state
let lastResponseId = null;
let conversationContext = [];
let currentConversationId = null;
let pausedConversation = false;
let pausedConversationContext = [];
let pausedConversationId = null;

// Store per-conversation histories
let conversationHistories = {};

// Add a new structure for storing response history by conversation
let responseHistory = {};
let allResponseHistory = [];

// Maximum number of commands to store in history
const MAX_HISTORY = 50;

// Available commands with descriptions
const commands = {
  'exit': 'Exit the application',
  'menu': 'Return to mode selection menu',
  'history': 'Show response history for the current conversation',
  'help': 'Show help information',
  'clear': 'Clear the screen',
  'continue': 'Resume paused conversation or continue from a specific response',
  'new': 'Start a new conversation with fresh history',
  'debug': 'Show current conversation state (for troubleshooting)'
};

// Command autocomplete function - define before using it in readline
function commandCompleter(line) {
  // Only provide completions for commands starting with /
  if (line.startsWith('/')) {
    const partial = line.slice(1);  // Remove the slash
    
    // Filter commands that start with the partial text
    const matches = Object.keys(commands).filter(cmd => 
      cmd.startsWith(partial.toLowerCase())
    );
    
    // Return the matches and the partial string we're completing
    return [
      matches.length ? matches.map(match => '/' + match) : [],
      line
    ];
  }
  
  // Default - no autocompletion
  return [[], line];
}

// Setup readline with raw mode to capture keystrokes
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
  completer: commandCompleter
});

// Function to create directories with secure permissions after user confirmation
function ensureSecureDirectories(callback) {
  if (!fs.existsSync(CLIP_DIR)) {
    console.log(chalk.yellow('\nSecurity Notice:'));
    console.log(`CLIP will create a secure directory at ${CLIP_DIR} to store conversation data.`);
    console.log(`This directory will have secure permissions (only you can access it).`);
    
    rl.question('\nDo you want to continue? (y/n): ', (answer) => {
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.log(chalk.dim('Setup cancelled. Exiting.'));
        process.exit(0);
      }
      
      // Create directories with secure permissions
      fs.mkdirSync(CLIP_DIR, { recursive: true, mode: 0o700 }); // Only owner can read/write/execute
      fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true, mode: 0o700 });
      fs.mkdirSync(RESPONSES_DIR, { recursive: true, mode: 0o700 });
      
      console.log(chalk.green(`Secure directories created successfully.`));
      callback();
    });
  } else {
    // Directories already exist, no need to prompt
    callback();
  }
}

// Debugging helper functions
function isDebugMode() {
  return process.env.DEBUG && 
    (process.env.DEBUG.includes('clipai') || 
     process.env.DEBUG.includes('*') || 
     process.env.DEBUG === 'true');
}

function getDebugLevel() {
  if (!isDebugMode()) return 0;
  if (process.env.DEBUG.includes(':verbose')) return 2;
  if (process.env.DEBUG.includes(':debug')) return 3;
  return 1; // info is default level
}

function debugLog(message, level = 1) {
  if (getDebugLevel() >= level) {
    const prefix = level === 1 ? 'INFO' : level === 2 ? 'VERBOSE' : 'DEBUG';
    console.log(chalk.dim(`[CLIPAI:${prefix}] ${message}`));
  }
}

// Add this function after the debugLog function
async function makeApiRequestWithRetry(client, apiRequest, maxRetries = 3) {
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      return await client.responses.create(apiRequest);
    } catch (error) {
      if (error.status === 429) { // Rate limiting
        const backoffTime = Math.pow(2, retries) * 1000;
        console.log(chalk.yellow(`Rate limited. Retrying in ${backoffTime/1000} seconds...`));
        await new Promise(resolve => setTimeout(resolve, backoffTime));
        retries++;
      } else if (error.status >= 500) { // Server error
        const backoffTime = Math.pow(2, retries) * 1000;
        console.log(chalk.yellow(`Server error. Retrying in ${backoffTime/1000} seconds...`));
        await new Promise(resolve => setTimeout(resolve, backoffTime));
        retries++;
      } else {
        // Non-recoverable error
        console.error(chalk.red(`API Error: ${error.message}`));
        if (isDebugMode() && error.stack) {
          debugLog(error.stack, 3);
        }
        throw error;
      }
    }
  }
  
  throw new Error('Maximum retries exceeded');
}

// Load state and history from the new file structure
function loadState() {
  try {
    // Create default state if it doesn't exist
    if (!fs.existsSync(STATE_FILE)) {
      const defaultState = {
        lastResponseId: null,
        conversationContext: [],
        currentConversationId: null,
        pausedConversation: false,
        pausedConversationContext: [],
        pausedConversationId: null
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState, null, 2));
    } else {
      // Load existing state
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      lastResponseId = state.lastResponseId;
      conversationContext = state.conversationContext;
      currentConversationId = state.currentConversationId;
      pausedConversation = state.pausedConversation;
      pausedConversationContext = state.pausedConversationContext;
      pausedConversationId = state.pausedConversationId;
    }

    // Load conversation histories
    if (fs.existsSync(CONVERSATIONS_DIR)) {
      const files = fs.readdirSync(CONVERSATIONS_DIR);
      files.forEach(file => {
        if (file.endsWith('.json')) {
          const convId = file.replace('.json', '');
          const convData = JSON.parse(fs.readFileSync(path.join(CONVERSATIONS_DIR, file), 'utf8'));
          conversationHistories[convId] = convData.history || [];
        }
      });
    }

    // Load response history organized by conversation
    if (fs.existsSync(RESPONSES_DIR)) {
      const files = fs.readdirSync(RESPONSES_DIR);
      files.forEach(file => {
        if (file.endsWith('.json')) {
          const convId = file.replace('.json', '');
          const respData = JSON.parse(fs.readFileSync(path.join(RESPONSES_DIR, file), 'utf8'));
          responseHistory[convId] = respData || [];
          
          // Add to the all responses list for global history view
          if (Array.isArray(respData)) {
            allResponseHistory = allResponseHistory.concat(
              respData.map(r => ({...r, conversationId: convId}))
            );
          }
        }
      });
    }
    
    // Sort all responses by timestamp (most recent first)
    allResponseHistory.sort((a, b) => b.timestamp - a.timestamp);
    
  } catch (e) {
    console.error(chalk.red('Error loading state:'), e);
    // Initialize with empty state if there's an error
    resetState();
  }
}

// Reset to default state
function resetState() {
  lastResponseId = null;
  conversationContext = [];
  currentConversationId = null;
  pausedConversation = false;
  pausedConversationContext = [];
  pausedConversationId = null;
  commandHistory = [];
  conversationHistories = {};
  responseHistory = {};
  allResponseHistory = [];
}

// Save conversation state to file
function saveState() {
  try {
    const state = {
      lastResponseId,
      conversationContext,
      currentConversationId,
      pausedConversation,
      pausedConversationContext,
      pausedConversationId
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    
    // If we have a current conversation, save its specific data
    if (currentConversationId) {
      const convFile = path.join(CONVERSATIONS_DIR, `${currentConversationId}.json`);
      const convData = {
        id: currentConversationId,
        context: conversationContext,
        history: conversationHistories[currentConversationId] || []
      };
      fs.writeFileSync(convFile, JSON.stringify(convData, null, 2));
    }
  } catch (e) {
    console.error(chalk.red('Failed to save conversation state:'), e);
  }
}

// Save history to conversation-specific file
function saveHistory(command) {
  if (command && command.trim() !== '' && !command.startsWith('/')) {
    // Don't add duplicates
    if (commandHistory.length === 0 || commandHistory[commandHistory.length - 1] !== command) {
      commandHistory.push(command);
      
      // Limit history size
      if (commandHistory.length > MAX_HISTORY) {
        commandHistory = commandHistory.slice(-MAX_HISTORY);
      }
      
      try {
        // If we're in a conversation, save to conversation-specific history
        if (currentConversationId) {
          conversationHistories[currentConversationId] = commandHistory;
          saveState(); // This will save the conversation data including history
        }
      } catch (e) {
        console.error(chalk.red('Failed to save command history:'), e);
      }
    }
  }
}

// Save response to conversation-specific history
function saveResponseToHistory(userPrompt, aiResponse, responseId) {
  if (responseId && aiResponse && currentConversationId) {
    // Create a history entry with prompt, response, and ID
    const historyEntry = {
      prompt: userPrompt,
      response: aiResponse.substring(0, 100) + (aiResponse.length > 100 ? '...' : ''), // Truncate for display
      fullResponse: aiResponse,
      id: responseId,
      timestamp: Date.now()
    };

    // Initialize conversation response history if needed
    if (!responseHistory[currentConversationId]) {
      responseHistory[currentConversationId] = [];
    }

    // Add to the beginning of this conversation's array (most recent first)
    responseHistory[currentConversationId].unshift(historyEntry);
    
    // Limit history size per conversation
    if (responseHistory[currentConversationId].length > MAX_HISTORY) {
      responseHistory[currentConversationId] = responseHistory[currentConversationId].slice(0, MAX_HISTORY);
    }
    
    // Also update the global history
    allResponseHistory.unshift({...historyEntry, conversationId: currentConversationId});
    if (allResponseHistory.length > MAX_HISTORY * 5) { // Allow more entries in global history
      allResponseHistory = allResponseHistory.slice(0, MAX_HISTORY * 5);
    }
    
    try {
      // Save this conversation's response history to its own file
      const respFile = path.join(RESPONSES_DIR, `${currentConversationId}.json`);
      fs.writeFileSync(respFile, JSON.stringify(responseHistory[currentConversationId], null, 2));
    } catch (e) {
      console.error(chalk.red('Failed to save response history:'), e);
    }
  }
}

// Show command history - updated to show responses from current or all conversations
function showHistory(showAll = false) {
  if (showAll) {
    console.log('\n' + chalk.dim('Response History (All Conversations):'));
    if (allResponseHistory.length === 0) {
      console.log(chalk.dim('No response history yet.'));
    } else {
      console.log(chalk.dim('You can continue from any response using "/continue n" (e.g., "/continue 2")'));
      console.log('');
      
      // Display responses with index numbers
      allResponseHistory.forEach((entry, i) => {
        // Format timestamp
        const date = new Date(entry.timestamp);
        const formattedDate = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
        
        console.log(chalk.bold(`${i + 1}.`) + chalk.dim(` [${formattedDate}]`));
        console.log(chalk.dim(`   Conversation: ${entry.conversationId.substring(0, 8)}...`));
        console.log(chalk.dim(`   Prompt: ${entry.prompt.substring(0, 60)}${entry.prompt.length > 60 ? '...' : ''}`));
        console.log(chalk.dim(`   Response: ${entry.response}`));
        console.log(chalk.dim(`   ID: ${entry.id.substring(0, 8)}...`));
        console.log(''); // Extra line between entries
      });
    }
  } else {
    // Show only current conversation responses
    console.log('\n' + chalk.dim(`Response History (Conversation: ${currentConversationId ? currentConversationId.substring(0, 8) + '...' : 'None'})`));
    
    const currentHistory = currentConversationId ? responseHistory[currentConversationId] || [] : [];
    
    if (!currentConversationId || currentHistory.length === 0) {
      console.log(chalk.dim('No response history for this conversation.'));
      console.log(chalk.dim('Use "/history --all" to view history across all conversations.'));
    } else {
      console.log(chalk.dim('You can continue from any response using "/continue n" (e.g., "/continue 2")'));
      console.log('');
      
      // Display responses with index numbers
      currentHistory.forEach((entry, i) => {
        // Format timestamp
        const date = new Date(entry.timestamp);
        const formattedDate = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
        
        console.log(chalk.bold(`${i + 1}.`) + chalk.dim(` [${formattedDate}]`));
        console.log(chalk.dim(`   Prompt: ${entry.prompt.substring(0, 60)}${entry.prompt.length > 60 ? '...' : ''}`));
        console.log(chalk.dim(`   Response: ${entry.response}`));
        console.log(chalk.dim(`   ID: ${entry.id.substring(0, 8)}...`));
        console.log(''); // Extra line between entries
      });
    }
  }
  console.log(''); // Add empty line at the end
}

// Start a new conversation with fresh history
function startNewConversation() {
  lastResponseId = null;
  conversationContext = [];
  // Generate a new conversation ID using a timestamp
  currentConversationId = `conv_${Date.now()}`;
  // Clear command history for this new conversation
  commandHistory = [];
  // Save the empty history for this conversation
  conversationHistories[currentConversationId] = commandHistory;
  saveState();
  
  return currentConversationId;
}

// Keep track of current input
let currentInput = '';
let showingCommandMenu = false;
// Track web search mode - default to disabled
let webSearchEnabled = false;

// Get API key from environment variable
const apiKey = process.env.OPENAI_API_KEY;

// Show the command menu
function showCommandMenu() {
  console.log('\n' + chalk.dim('Available Commands:'));
  Object.keys(commands).forEach(cmd => {
    console.log(chalk.bold(`/${cmd}`) + chalk.dim(` - ${commands[cmd]}`));
  });
  console.log(''); // Extra line for spacing
  showingCommandMenu = true;
}

// Toggle web search mode
function toggleWebSearch() {
  webSearchEnabled = !webSearchEnabled;
  
  // Clear the current line
  process.stdout.clearLine();
  process.stdout.cursorTo(0);
  
  // Show visual feedback about the mode change
  if (webSearchEnabled) {
    console.log('\n' + chalk.green('✓ Web search enabled') + chalk.dim(' - AI can now search the web'));
  } else {
    console.log('\n' + chalk.yellow('✗ Web search disabled') + chalk.dim(' - AI will use its training data only'));
  }
  
  // Reprint the prompt
  process.stdout.write('\n> ');
  // If there was input, restore it
  if (currentInput) {
    process.stdout.write(currentInput);
  }
}

// Show help menu with updated information about web search toggle
function showHelp() {
  console.log('\n' + chalk.dim('Usage:'));
  console.log('  Type your message to chat with the AI');
  console.log('  Type / to see available commands');
  console.log('  Type /command to execute a command (use Tab to autocomplete)');
  
  console.log('\n' + chalk.dim('Keyboard Shortcuts:'));
  console.log('  Ctrl+S - Toggle web search mode (current: ' + (webSearchEnabled ? chalk.green('enabled') : chalk.yellow('disabled')) + ')');
  
  console.log('\n' + chalk.dim('Conversation Management:'));
  console.log('  /continue - Resume the most recent conversation');
  console.log('  /continue n - Continue from response #n in current conversation');
  console.log('  /history - View response history for current conversation');
  console.log('  /history --all - View history across all conversations');
  console.log('  /new - Start a new conversation with fresh context');
  console.log('  /debug - Show the current conversation state (for troubleshooting)');
  
  console.log('\n' + chalk.dim('Note: After each response, the conversation is paused.'));
  console.log(chalk.dim('      You must use /continue to resume the conversation before asking follow-up questions.'));
  console.log(''); // Add empty line at the end
}

// Main function to handle user interaction - updated to skip mode selection
function startCLI() {
  console.clear();
  console.log("\n" + chalk.dim("✧") + " CLIP " + chalk.dim("✧") + "\n");
  
  // Show debug status
  if (isDebugMode()) {
    const level = getDebugLevel();
    const levelName = level === 1 ? 'info' : level === 2 ? 'verbose' : 'debug';
    debugLog(`Debug mode enabled at ${levelName} level`, 1);
    debugLog('Debug levels: DEBUG=clipai (info), DEBUG=clipai:verbose, DEBUG=clipai:debug', 1);
  }
  
  // Initialize by loading state from files
  loadState();
  
  // But always start with a fresh conversation
  lastResponseId = null;
  conversationContext = [];
  currentConversationId = null;
  pausedConversation = false;
  pausedConversationContext = [];
  pausedConversationId = null;
  
  // Also clear command history for the new conversation
  commandHistory = [];
  
  // But we keep the response history which is already loaded
  
  // Save the clean initial state
  saveState();
  
  if (!apiKey) {
    rl.question('Enter your OpenAI API key: ', (key) => {
      if (!key) {
        console.log(chalk.dim('No API key provided. Exiting.'));
        rl.close();
        return;
      }
      // Set API key only in environment variable, never store in files
      process.env.OPENAI_API_KEY = key;
      
      // Start chat directly without mode selection
      console.log(chalk.dim("\nWelcome to CLIP! Type your message or type '/' to see available commands."));
      console.log(chalk.dim("Pro tip: Press Ctrl+S to toggle web search capability."));
      console.log(chalk.dim(`Current mode: ${webSearchEnabled ? chalk.green('Web search enabled') : chalk.yellow('Standard mode')}`));
      promptUser();
    });
  } else {
    // Start chat directly without mode selection
    console.log(chalk.dim("\nWelcome to CLIP! Type your message or type '/' to see available commands."));
    console.log(chalk.dim("Pro tip: Press Ctrl+S to toggle web search capability."));
    console.log(chalk.dim(`Current mode: ${webSearchEnabled ? chalk.green('Web search enabled') : chalk.yellow('Standard mode')}`));
    promptUser();
  }
}

// Clear the screen - updated to show current mode
function clearScreen() {
  console.clear();
  console.log("\n" + chalk.dim("✧") + " CLIP " + chalk.dim("✧") + "\n");
  console.log(chalk.dim(`Mode: ${webSearchEnabled ? chalk.green('Web Search') : chalk.yellow('Standard')}`));
}

// Function to handle the user's prompt - update to use webSearchEnabled from global state
function handlePrompt(prompt) {
  if (!prompt.trim()) {
    promptUser();
    return;
  }

  // Check for commands that start with /
  if (prompt.startsWith('/')) {
    const commandWithArgs = prompt.substring(1);
    const commandParts = commandWithArgs.split(/\s+/);
    const command = commandParts[0].toLowerCase();
    
    switch (command) {
      case 'exit':
        console.log('\n' + chalk.dim('Goodbye'));
        rl.close();
        return;
        
      case 'help':
        showHelp();
        promptUser();
        return;
        
      case 'menu':
        // Removed menu option - just show help instead
        showHelp();
        promptUser();
        return;
        
      case 'history':
        // Check if we're showing all history or just current conversation
        const showAllHistory = commandParts.length > 1 && commandParts[1] === '--all';
        showHistory(showAllHistory);
        promptUser();
        return;
        
      case 'clear':
        clearScreen();
        promptUser();
        return;
        
      case 'continue':
        // Check if there's a number parameter
        const historyIndex = commandParts.length > 1 ? parseInt(commandParts[1], 10) - 1 : null;
        
        // Use the new helper function for continuing conversations
        continueConversation(historyIndex);
        promptUser();
        return;
        
      case 'new':
        // Ensure we clear any paused conversation
        pausedConversation = false;
        pausedConversationContext = [];
        pausedConversationId = null;
        
        const newConvId = startNewConversation();
        console.log(chalk.dim(`Started new conversation`));
        promptUser();
        return;
        
      case 'debug':
        // Show conversation state for debugging
        console.log('\n' + chalk.dim('Current conversation state:'));
        console.log(chalk.dim(`Current conversation ID: ${currentConversationId || 'None'}`));
        console.log(chalk.dim(`Last response ID: ${lastResponseId || 'None'}`));
        console.log(chalk.dim(`Conversation context: ${conversationContext.length} messages`));
        console.log(chalk.dim(`Paused conversation: ${pausedConversation ? 'Yes' : 'No'}`));
        
        if (pausedConversation) {
          console.log(chalk.dim(`Paused conversation ID: ${pausedConversationId || 'None'}`));
          console.log(chalk.dim(`Paused conversation context: ${pausedConversationContext.length} messages`));
        }
        
        promptUser();
        return;
        
      default:
        console.log(chalk.dim(`Unknown command: /${command}`));
        console.log(chalk.dim('Type / to see available commands'));
        promptUser();
        return;
    }
  }

  // Track start time for response time calculation
  const startTime = Date.now();
  
  // Response values
  let fullResponse = "";
  let chunkCount = 0;
  let webSearchUsed = false;
  let searchResults = [];
  let responseId = null;
  
  console.log('\n' + chalk.bold('AI: '));
  
  // Create request for the OpenAI Responses API
  let apiRequest = {
    model: "gpt-4o",
    input: [], // Use input instead of messages for Responses API
    stream: true,
    temperature: 0.7
  };
  
  // Log when we're using conversation context
  if (conversationContext.length > 0) {
    console.log(chalk.dim(`Using conversation context with ${conversationContext.length} messages`));
  }

  // If there's a lastResponseId, use it for continuing the conversation
  if (lastResponseId) {
    console.log(chalk.dim(`Continuing with response ID: ${lastResponseId.substring(0, 8)}...`));
    
    // Set previous_response_id in the request for conversation continuity
    apiRequest.previous_response_id = lastResponseId;
    
    // For OpenAI's Responses API, when using previous_response_id,
    // we should only send the new user query without the history
    // as the API will maintain the conversation history for us
    apiRequest.input = [{
      role: "user",
      content: prompt
    }];
  } else {
    // No previous response ID, use conversation context
    // Add any existing conversation context
    if (conversationContext.length > 0) {
      apiRequest.input = [...conversationContext];
    }
    
    // Add user's current message to the request
    apiRequest.input.push({
      role: "user",
      content: prompt
    });
  }
  
  // Add web search capability if enabled
  if (webSearchEnabled) {
    console.log(chalk.dim('[Web search enabled]'));
    apiRequest.tools = [{ type: "web_search" }];
  }
  
  // Debug output of request config
  if (isDebugMode()) {
    const level = getDebugLevel();
    // Clone the request to not modify the original
    const debugConfig = {...apiRequest};
    
    if (debugConfig.input) {
      if (level >= 3) {
        // Full debug - show actual messages but truncate content for readability
        debugConfig.input = debugConfig.input.map(msg => ({
          role: msg.role,
          content: msg.content.length > 100 
            ? msg.content.substring(0, 100) + '...' 
            : msg.content
        }));
      } else {
        // Info level - just show count
        debugConfig.input = `[${debugConfig.input.length} messages]`;
      }
    }
    
    debugLog(`Request config: ${JSON.stringify(debugConfig, null, 2)}`, 1);
  }

  // Always log basic request info
  console.log(chalk.dim(`Sending request: ${apiRequest.model}, tools: ${apiRequest.tools ? 'yes' : 'no'}, prevResponseId: ${apiRequest.previous_response_id ? 'yes' : 'no'}`));

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    httpAgent: new https.Agent({
      rejectUnauthorized: true // Enforce certificate validation
    })
  });
  
  console.log(chalk.dim('Response:'));
  console.log(chalk.dim(DIVIDER));
  
  // Don't enable DEBUG temporarily anymore, respect the environment variable
  const originalDebugLevel = getDebugLevel();
  
  makeApiRequestWithRetry(client, apiRequest).then(response => {
    // No need to restore debug setting
    
    // Check if we received a non-streaming complete response
    if (!response.on && response.id && response.output) {
      // This is a complete response object, not a stream
      console.log(chalk.dim('Received complete response object instead of stream'));
      
      let fullResponse = '';
      responseId = response.id;
      
      // Extract text from the response structure
      if (response.output && Array.isArray(response.output)) {
        const message = response.output[0];
        if (message && message.content && Array.isArray(message.content)) {
          for (const content of message.content) {
            if (content.type === 'output_text' && content.text) {
              fullResponse += content.text;
              // Print the response
              process.stdout.write(content.text);
            }
          }
        }
      }
      
      // Save ID without displaying it
      lastResponseId = responseId;
      
      // Save to response history
      saveResponseToHistory(prompt, fullResponse, responseId);
      
      // Save context for continuing the conversation
      if (fullResponse) {
        // First, ensure we have a valid conversation ID
        if (!currentConversationId) {
          currentConversationId = `conv_${Date.now()}`;
        }
        
        // Create message objects
        const newUserMessage = { role: "user", content: prompt };
        const newAssistantMessage = { role: "assistant", content: fullResponse };
        
        // Add user message to context if needed
        if (conversationContext.length === 0) {
          conversationContext = [newUserMessage];
        } else {
          // Check if last message is the same user message
          const lastMessage = conversationContext[conversationContext.length - 1];
          if (!(lastMessage.role === "user" && lastMessage.content === prompt)) {
            conversationContext.push(newUserMessage);
          }
        }
        
        // Add assistant response
        conversationContext.push(newAssistantMessage);
        
        // Save for paused state
        pausedConversationContext = [...conversationContext];
        pausedConversationId = currentConversationId;
        pausedConversation = true;
        
        // Clear conversation context for next prompt but keep conversation ID
        conversationContext = [];
        
        // Save state
        saveState();
        
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log('\n'); // Add spacing
        
        // Streamlined stats display 
        const mode = webSearchEnabled ? chalk.green('Web Search') : chalk.yellow('Standard');
        let statsOutput = `${totalTime}s · ${fullResponse.length} chars · ${mode} · Type /continue to resume`;
        
        console.log(chalk.dim(statsOutput));
        
        promptUser();
      }
      
      return;
    }
    
    // If we reach here, we have a stream
    const stream = response;
    
    (async () => {
      try {
        // Check if the stream object itself has an ID
        if (stream.id) {
          responseId = stream.id;
        }
        
        for await (const event of stream) {
          // Debug log the event type for troubleshooting
          if (isDebugMode()) {
            debugLog(`Event type: ${event.type}`, 2);
            
            if (getDebugLevel() >= 3) {
              // Only log full event data at debug level
              debugLog(`Event data: ${JSON.stringify(event).substring(0, 200)}...`, 3);
            }
          }
          
          // Extract response ID from various event types
          // Primary method: response object with id
          if (event.id && !responseId) {
            responseId = event.id;
          }
          
          // For the standard response.created event (most reliable source)
          if (event.type === 'response.created' && event.response && event.response.id) {
            responseId = event.response.id;
          }
          
          // Alternative response ID sources
          else if (event.object === 'response' && event.id) {
            responseId = event.id;
          }
          else if (event.type === 'response' && event.id) {
            responseId = event.id;
          }
          else if (event.response_id) {
            responseId = event.response_id;
          }
          // In the full response object case
          else if (event.output && Array.isArray(event.output) && event.output.length > 0) {
            if (!responseId && event.id) {
              responseId = event.id;
            }
          }
          
          // Handle text output with proper padding for continuation lines
          if (event.type === 'output_text.delta' && event.delta) {
            process.stdout.write(event.delta);
            fullResponse += event.delta;
            chunkCount++;
          } 
          // Legacy event type (keeping for backward compatibility)
          else if (event.type === 'response.output_text.delta' && event.delta) {
            process.stdout.write(event.delta);
            fullResponse += event.delta;
            chunkCount++;
          }
          // For the full response object format
          else if (event.output && Array.isArray(event.output) && event.output.length > 0) {
            const message = event.output[0];
            if (message && message.content && Array.isArray(message.content)) {
              for (const content of message.content) {
                if (content.type === 'output_text' && content.text) {
                  const text = content.text;
                  process.stdout.write(text);
                  fullResponse += text;
                  chunkCount++;
                }
              }
            }
          }
          // Track web search usage
          else if (event.type === 'tool_use.in_progress' || event.type === 'response.tool_use.in_progress') {
            webSearchUsed = true;
            process.stdout.write(chalk.dim('\n[Searching the web...]\n'));
          }
          // Track search results
          else if ((event.type === 'tool_use.done' || event.type === 'response.tool_use.done') && 
                  event.item && 
                  event.item.type === 'web_search' && 
                  event.item.metadata && 
                  event.item.metadata.snippets) {
            
            searchResults = event.item.metadata.snippets;
            
            process.stdout.write(chalk.dim('\n[Search complete]\n'));
          }
        }
      } catch (error) {
        console.error(chalk.red(`\nError processing response stream: ${error.message}`));
        if (error.stack) {
          console.error(chalk.dim(error.stack));
        }
      }
      
      // Process received data
      if (fullResponse) {
        // Ensure we have a conversation ID
        if (!currentConversationId) {
          currentConversationId = `conv_${Date.now()}`;
        }
        
        // Create message objects
        const newUserMessage = { role: "user", content: prompt };
        const newAssistantMessage = { role: "assistant", content: fullResponse };
        
        // Add user message to context if needed
        if (conversationContext.length === 0) {
          conversationContext = [newUserMessage];
        } else {
          const lastMessage = conversationContext[conversationContext.length - 1];
          if (!(lastMessage.role === "user" && lastMessage.content === prompt)) {
            conversationContext.push(newUserMessage);
          }
        }
        
        // Add assistant response
        conversationContext.push(newAssistantMessage);
        
        // Save for paused state
        pausedConversationContext = [...conversationContext];
        pausedConversationId = currentConversationId;
        pausedConversation = true;
        
        // Save response ID
        if (responseId) {
          lastResponseId = responseId;
          saveResponseToHistory(prompt, fullResponse, responseId);
        } else {
          console.log('\n' + chalk.dim('No response ID received. Conversation continuity may be limited.'));
          lastResponseId = null;
        }
        
        // Clear for next prompt
        conversationContext = [];
        saveState();
        
        // Display stats and continue
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log('\n');
        
        // Streamlined stats display
        const mode = webSearchEnabled ? chalk.green('Web Search') : chalk.yellow('Standard');
        let statsOutput = `${totalTime}s · ${fullResponse.length} chars · ${mode}`;
        
        // Add web search info if relevant
        if (webSearchEnabled && webSearchUsed) {
          statsOutput += ` · Used web search`;
        }
        
        // Add pause info
        statsOutput += ` · Type /continue to resume`;
        
        console.log(chalk.dim(statsOutput));
        
        // Show sources if needed
        if (searchResults.length > 0) {
          console.log(chalk.dim(`Sources: ${searchResults.length > 3 ? 'First 3 of ' + searchResults.length : searchResults.length}`));
          searchResults.slice(0, 3).forEach((result, index) => {
            if (result.url) {
              console.log(chalk.dim(`  ${index + 1}. ${result.url.substring(0, 70)}${result.url.length > 70 ? '...' : ''}`));
            }
          });
          if (searchResults.length > 3) {
            console.log(chalk.dim(`  (Use /history to view all sources)`));
          }
        }
      } else {
        console.log('\n' + chalk.red('Empty response received, conversation continuity may not work'));
      }
      
      // Continue with user interaction
      promptUser();
    })();
  }).catch(error => {
    // Enhanced error handling using debug levels
    console.error('\n' + chalk.red('Error: ') + error.message);
    
    if (isDebugMode()) {
      // Log detailed error information based on debug level
      debugLog('Full error details:', 1);
      
      if (error.response) {
        debugLog(`Response status: ${error.response.status}`, 1);
        
        if (getDebugLevel() >= 2) {
          debugLog(`Response headers: ${JSON.stringify(error.response.headers)}`, 2);
          
          if (error.response.data && getDebugLevel() >= 2) {
            debugLog(`Response data: ${JSON.stringify(error.response.data, null, 2)}`, 2);
          }
        }
      }
      
      // Log the request that failed
      if (getDebugLevel() >= 2) {
        debugLog('Request that failed:', 2);
        const sanitizedRequest = {...apiRequest};
        if (sanitizedRequest.input) {
          sanitizedRequest.input = sanitizedRequest.input.map(msg => ({
            role: msg.role,
            content: msg.content.length > 50 ? msg.content.substring(0, 50) + '...' : msg.content
          }));
        }
        debugLog(JSON.stringify(sanitizedRequest, null, 2), 2);
      }
      
      // Show stack trace at highest debug level
      if (getDebugLevel() >= 3 && error.stack) {
        debugLog(`Stack trace: ${error.stack}`, 3);
      }
    } else {
      console.error(chalk.dim('Set DEBUG=clipai to see more details about this error.'));
    }
    
    promptUser();
  });
}

// Function to prompt the user for input - updated to use global webSearchEnabled
function promptUser() {
  // Just show the current mode (standard or web search)
  const mode = webSearchEnabled ? chalk.green('Web Search') : chalk.yellow('Standard');
  
  // Simple minimal prompt
  let statusInfo = `${mode}`;
  
  // Add paused conversation info if available
  if (pausedConversation) {
    statusInfo += ` · Paused conversation (${pausedConversationContext.length} msgs)`;
  } else if (conversationContext.length > 0) {
    statusInfo += ` · Active conversation (${conversationContext.length} msgs)`;
  } else if (lastResponseId) {
    statusInfo += ` · Continuing conversation`;
  }
  
  console.log(chalk.dim(`\n${statusInfo}`));
  
  // Always show the prompt
  rl.question('> ', (prompt) => {
    // Store the current input for restoring after mode toggle
    currentInput = ''; 
    
    const trimmedPrompt = prompt.trim();
    
    // Handle commands
    if (trimmedPrompt.startsWith('/')) {
      const commandWithArgs = trimmedPrompt.substring(1);
      const commandParts = commandWithArgs.split(/\s+/);
      const command = commandParts[0].toLowerCase();
      
      switch (command) {
        case 'exit':
          console.log('\n' + chalk.dim('Goodbye'));
          rl.close();
          return;
          
        case 'help':
          showHelp();
          promptUser();
          return;
          
        case 'menu':
          // Removed menu option - just show help instead
          showHelp();
          promptUser();
          return;
          
        case 'history':
          // Check if we're showing all history or just current conversation
          const showAllHistory = commandParts.length > 1 && commandParts[1] === '--all';
          showHistory(showAllHistory);
          promptUser();
          return;
          
        case 'clear':
          clearScreen();
          promptUser();
          return;
          
        case 'continue':
          // Check if there's a number parameter
          const historyIndex = commandParts.length > 1 ? parseInt(commandParts[1], 10) - 1 : null;
          
          // Use the new helper function for continuing conversations
          continueConversation(historyIndex);
          promptUser();
          return;
          
        case 'new':
          // Ensure we clear any paused conversation
          pausedConversation = false;
          pausedConversationContext = [];
          pausedConversationId = null;
          
          const newConvId = startNewConversation();
          console.log(chalk.dim(`Started new conversation`));
          promptUser();
          return;
          
        case 'debug':
          // Show conversation state for debugging
          console.log('\n' + chalk.dim('Current conversation state:'));
          console.log(chalk.dim(`Current conversation ID: ${currentConversationId || 'None'}`));
          console.log(chalk.dim(`Last response ID: ${lastResponseId || 'None'}`));
          console.log(chalk.dim(`Conversation context: ${conversationContext.length} messages`));
          console.log(chalk.dim(`Paused conversation: ${pausedConversation ? 'Yes' : 'No'}`));
          
          if (pausedConversation) {
            console.log(chalk.dim(`Paused conversation ID: ${pausedConversationId || 'None'}`));
            console.log(chalk.dim(`Paused conversation context: ${pausedConversationContext.length} messages`));
          }
          
          promptUser();
          return;
          
        default:
          console.log(chalk.dim(`Unknown command: /${command}`));
          console.log(chalk.dim('Type / to see available commands'));
          promptUser();
          return;
      }
    }
    
    // For any regular message or history recall, we should start a new conversation
    // unless we've explicitly used /continue or we're in an active conversation
    
    // If we have a paused conversation and haven't used /continue, start fresh
    if (pausedConversation && conversationContext.length === 0) {
      // console.log(chalk.dim('Starting a new conversation. The previous conversation is still paused.'));
      currentConversationId = null;
      conversationContext = [];
    }
    
    // If this is our first prompt and we don't have a conversation ID yet, start a new one
    if (!currentConversationId) {
      currentConversationId = `conv_${Date.now()}`;
      conversationHistories[currentConversationId] = [];  // Start with empty history
      commandHistory = [];  // Reset command history for new conversation
      saveState();
      // console.log(chalk.dim(`Starting new conversation (ID: ${currentConversationId.substring(0, 8)}...)...`));
    }
    
    // Regular prompt - just send it
    if (trimmedPrompt) {
      saveHistory(trimmedPrompt);
      handlePrompt(trimmedPrompt);
    } else {
      promptUser();
    }
  });
}

// Set up keystroke handling for command menu and toggle shortcut
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdin.on('data', (key) => {
  // Convert buffer to string
  const str = key.toString();
  
  // Check for Ctrl+S (ASCII code 19) to toggle web search
  if (key[0] === 19) {
    toggleWebSearch();
    return;
  }
  
  // Check if the user pressed /
  if (str === '/' && !showingCommandMenu) {
    showCommandMenu();
    showingCommandMenu = false; // Reset after showing
    
    // Reprint the prompt line with the slash
    process.stdout.write('\n> /');
  }
  
  // Store current input for potential restoring after mode change
  if (rl.line) {
    currentInput = rl.line;
  }
});

// Change this to use the new directory creation function
function init() {
  // First ensure secure directories exist, then start the CLI
  ensureSecureDirectories(() => {
    startCLI();
  });
}

// Initialize the application
init();

// Handle CTRL+C gracefully
process.on('SIGINT', () => {
  console.log('\n' + chalk.dim('Exiting...'));
  rl.close();
  process.exit();
});

// Function for continuing a conversation using the /continue command
function continueConversation(historyIndex) {
  // If we're continuing from a paused conversation (most common case)
  if (historyIndex === null && pausedConversation) {
    // Restore the paused conversation
    console.log(chalk.dim(`Resuming paused conversation...`));
    conversationContext = [...pausedConversationContext];
    currentConversationId = pausedConversationId;
    
    // Use the last response ID from the paused conversation
    if (pausedConversationContext.length >= 2) {
      const lastAssistantMessage = pausedConversationContext
        .filter(msg => msg.role === "assistant")
        .pop();
      
      // Find the corresponding response ID in response history
      if (currentConversationId && responseHistory[currentConversationId]) {
        const matchingResponse = responseHistory[currentConversationId].find(
          resp => resp.fullResponse === lastAssistantMessage?.content
        );
        
        if (matchingResponse) {
          lastResponseId = matchingResponse.id;
          console.log(chalk.dim(`Using response ID: ${lastResponseId.substring(0, 8)}...`));
        }
      }
    }
    
    // Load any command history for this conversation
    if (currentConversationId && conversationHistories[currentConversationId]) {
      commandHistory = conversationHistories[currentConversationId];
    }
    
    // Clear the paused state since we're resuming it
    pausedConversation = false;
    pausedConversationContext = [];
    pausedConversationId = null;
    
    // Save the updated state
    saveState();
    
    return true;
  }
  
  // Get responses from current conversation
  const currentResponses = currentConversationId && responseHistory[currentConversationId] 
    ? responseHistory[currentConversationId] 
    : [];
  
  // If continuing from a specific response in the current conversation
  if (historyIndex !== null && historyIndex >= 0 && historyIndex < currentResponses.length) {
    const selectedResponse = currentResponses[historyIndex];
    console.log(chalk.dim(`Continuing from response #${historyIndex + 1}`));
    
    // Set the response ID to continue from
    lastResponseId = selectedResponse.id;
    
    // Keep the current conversation ID or create a new one if needed
    if (!currentConversationId) {
      currentConversationId = `conv_${Date.now()}`;
    }
    
    // Add the context of this specific response for better continuity
    conversationContext = [
      { role: "user", content: selectedResponse.prompt },
      { role: "assistant", content: selectedResponse.fullResponse }
    ];
    
    // Save the updated state
    saveState();
    
    return true;
  }
  
  // If continuing from most recent response in the current conversation
  if (currentConversationId && responseHistory[currentConversationId] && responseHistory[currentConversationId].length > 0) {
    const lastResponse = responseHistory[currentConversationId][0]; // Most recent first
    console.log(chalk.dim(`Continuing from most recent response`));
    
    lastResponseId = lastResponse.id;
    
    // Add the context of this response to improve continuity
    conversationContext = [
      { role: "user", content: lastResponse.prompt },
      { role: "assistant", content: lastResponse.fullResponse }
    ];
    
    // Save state
    saveState();
    
    return true;
  }
  
  // Fallback to any response if we have no current conversation history
  if (allResponseHistory.length > 0) {
    const lastResponse = allResponseHistory[0];
    console.log(chalk.dim(`Continuing from most recent response`));
    
    lastResponseId = lastResponse.id;
    
    // Create a new conversation since we're branching from a different one
    currentConversationId = `conv_${Date.now()}`;
    
    // Add the context of this response for better continuity
    conversationContext = [
      { role: "user", content: lastResponse.prompt },
      { role: "assistant", content: lastResponse.fullResponse }
    ];
    
    saveState();
    
    return true;
  }
  
  // No responses to continue from
  console.log(chalk.dim('No response history available to continue from.'));
  return false;
} 