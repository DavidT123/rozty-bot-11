module.exports = {
  apps: [
    {
      name: "roztypollo-bot",
      script: "./index.js",
      watch: false,
      max_memory_restart: "600M",
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      restart_delay: 3000
    }
  ]
};
