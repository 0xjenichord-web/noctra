resource "aws_s3_bucket" "data" {
  bucket = "my-data"
  acl    = "public-read"
}
resource "aws_security_group" "sg" {
  ingress {
    cidr_blocks = ["0.0.0.0/0"]
  }
}
