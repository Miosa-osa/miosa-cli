defmodule MyApp.MixProject do
  use Mix.Project

  def project do
    [app: :my_app, version: "0.1.0", deps: deps()]
  end

  defp deps do
    [{:phoenix, "~> 1.7"}, {:ecto_sql, "~> 3.0"}]
  end
end
