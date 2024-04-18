export default class ChatGPTPlugin {
  async init() {
    let HOOKS = {};

    switch (this.action) {
      case "update":
        HOOKS.update = (stream) => this.query(stream);
        break;
      case "add_metadata":
        HOOKS.add_metadata = (stream) => this.enhance(stream);
        break;
      case "generate":
        HOOKS.generate = () => this.start();
        break;
    }
    return {
      ROUTES: {
        GET: {
          chat: (req, res) => this.chatHtml(req, res),
        },
        POST: {
          "chat-submit": (req, res) => this.chatSubmit(req, res),
        },
      },
      HOOKS: HOOKS,
    };
  }

  async start() {
    // Perform first call
    this.createStream();

    // Start the interval function
    this.interval = setInterval(() => {
      this.createStream();
    }, this.secs_interval * 1000);
  }

  /** Will stop the plugin's interval */
  async stop() {
    console.log("Stopping plugin:", this.uuid);
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null; // Clear the stored interval ID
    }
  }

  /** Will create a stream every x seconds based on the user prompt */
  async createStream() {
    const parsedPrompt = await this.buildPrompt(this.prompt);
    const result = await this.fetchFromOpenAI({
      role: "user",
      content: parsedPrompt,
    });
    if (result) {
      /** We then create the stream in Ceramic with the updated content */
      try {
        let stream = await global.indexingService.ceramic.orbisdb
          .insert(this.model_id)
          .value(result)
          .context(this.context)
          .run();
      } catch (e) {
        console.log(
          "Error creating stream with model:" + this.model_id + ":",
          e
        );
      }
    } else {
      console.log("Couldn't create stream as `result` is undefined.");
    }
  }

  /** Will query ChatGPT based on the plugin settings */
  async query(content) {
    // Parse the prompt string and replace placeholders with actual values
    const parsedPrompt = await this.buildPrompt(this.prompt, content);

    const result = await this.fetchFromOpenAI({
      role: "user",
      content: parsedPrompt,
    });

    /** Will update the stream's content to add the description generated by GPT */
    let _content = { ...content };
    _content[this.field] = result;
    return _content;
  }

  /** Will return a JSON object classifying the book */
  async enhance(stream) {
    const parsedPrompt = await this.buildPrompt(this.prompt, stream.content);
    const result = await this.fetchFromOpenAI({
      role: "user",
      content: parsedPrompt,
    });

    /** Will return the classification of the book  */
    return result;
  }

  /** Will build the final prompt by parsing variables and performing queries if needed */
  async buildPrompt(prompt, content) {
    // Find all matches
    const matches = [...prompt.matchAll(/\$\{([\w.]+)\}/g)];

    // Process each match
    for (const match of matches) {
      const fullMatch = match[0];
      const variableName = match[1];

      let replacement;

      /** Handle reserved variable names such as query.results */
      switch (variableName) {
        case "query.results":
          try {
            let response = await global.indexingService.database.query(
              this.query
            );
            if (response && response.data) {
              replacement = JSON.stringify(response.data?.rows || "");
            }
          } catch (e) {
            console.log(
              "There was an error replacing query.results with the actual OrbisDB results."
            );
          }
          break;
        default:
          replacement = (content && content[variableName]) || "";
          break;
      }

      // Replace the match in the prompt
      prompt = prompt.replace(fullMatch, replacement);
    }

    return prompt;
  }

  chatHtml(req, res) {
    res.send(`
          <html>
            <head>
                <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
                <style>
                    .chat-body {
                        background: #f1f5f9;
                    }
        
                    .chat-history {
                        height: 80%;
                        overflow: auto;
                        margin: 0;
                    }
        
                    .chat-input {
                        padding: 10px;
                        background-color: #f8fafc;
                        border-radius: 4px;
                    }
        
                    .chat-submit {
                        padding: 10px;
                        border: none;
                        background: #007BFF;
                        color: #fff;
                        border-radius: 4px;
                    }
        
                    .chat-loading {
                        display: block;
                        font-style: italic;
                        color: #888;
                    }
                </style>
            </head>
            <body class="chat-body bg-slate-100 text-sm w-full h-full flex flex-col">
              <div id="chat-history" class="p-6 chat-history overflow-y-scroll flex flex-1 flex-col w-full border-b border-slate-200"></div>
              <form class="chat-form bg-white p-4 flex flex-col mb-0">
                <textarea id="content" name="content" class="border border-slate-200 chat-input w-full bg-slate-50 mb-2" placeholder="Type your question here..."></textarea>
                <input type="submit" value="Submit" class="chat-submit w-full cursor-pointer">
              </form>
              <script>
                document.getElementById('chat-form').addEventListener('submit', function(event) {
                  event.preventDefault();
                  var content = document.getElementById('content').value;
                  document.getElementById('chat-history').innerHTML += '<p class="chat-message"><strong>You:</strong> ' + content + '</p>';
                  document.getElementById('chat-history').innerHTML += '<p id="loading" class="chat-loading"><strong>Bot:</strong> Is typing...</p>';
                  fetch('./chat-submit', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ content: content })
                  })
                  .then(response => response.json())
                  .then(result => {
                    console.log("Data:", result.data);
                    document.getElementById('loading').style.display = 'none';
                    document.getElementById('chat-history').innerHTML += '<p class="chat-message"><strong>Bot:</strong> ' + result.data + '</p>';
                  });
                });
              </script>
            </body>
          </html>
        `);
  }

  async chatSubmit(req, res) {
    if (!req.body) {
      return {
        data: null,
      };
    }

    const { content } = req.body;
    console.log("Question asked:", content);
    const result = await this.fetchFromOpenAI({
      role: "user",
      content: content,
    });
    console.log("Answer:", result);

    return {
      data: result,
    };
  }

  /** Helper function to easily submit question to the OpenAI API */
  async fetchFromOpenAI(userMessage) {
    const messages = [
      {
        role: "system",
        content: "You are a helpful assistant.",
      },
      userMessage,
    ];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.secret_key}`,
        "OpenAI-Organization": this.organization_id,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo-1106",
        response_format: {
          type: this.is_json == "yes" ? "json_object" : "text",
        },
        messages: messages,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      console.error(
        "Error with ChatGPTPlugin  " + response.statusText + ": ",
        response.status
      );
      return;
    }

    const data = await response.json();
    if (this.is_json == "yes") {
      return JSON.parse(data.choices[0].message.content);
    } else {
      return data.choices[0].message.content;
    }
  }
}