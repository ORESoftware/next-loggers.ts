defmodule OresoftwareNextLoggers.MixProject do
  use Mix.Project

  def project do
    [
      app: :oresoftware_next_loggers,
      version: "0.1.0",
      elixir: ">= 1.16.0",
      start_permanent: Mix.env() == :prod,
      deps: []
    ]
  end

  def application, do: [extra_applications: [:logger]]
end
